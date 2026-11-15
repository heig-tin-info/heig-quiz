/**
 * A kiosk station's project sitting and its close (ADR-089, amendment of
 * 2026-11-15, point 4). The sitting is its approving `kiosk_pairings` row,
 * consumed; its end closes the portal session it opened, by a job
 * (`kiosk.close`, `jobs.ts`) that tells the portal and sets
 * `close_completed_at`. Until then the station is held: it cannot be paired.
 *
 * Every session row goes through `dropSessions` (`auth/session.ts`), which
 * asks here for the close of each removed `kiosk` row of a project
 * ({@link requestSittingCloses}); the kiosk ticker's sweep asks for the rest
 * — a sitting left with no session and no close, whatever removed it.
 *
 * `dropSessions` is called with a database handle and nothing else, so it
 * cannot reach `app.boss`: the queue is opened here once at boot by
 * `registerKioskJobs`, as the notifications' outbox is. Closed (a test,
 * `JOBS_DISABLED=1`, a queue that failed to start), nothing is enqueued and
 * the sweep closes the sitting inline instead.
 */
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import type { SittingCloseCause } from "../../audit.js";
import type { Db } from "../../db/client.js";
import { kioskPairings, sessions } from "../../db/schema.js";
import type { JobQueue } from "../../jobs.js";

/**
 * The close of one sitting (`{ sitting, projectId, cause }`): retried with
 * backoff, idempotent — a sitting already closed is done, and the portal
 * answers 204 to a replay.
 */
export const KIOSK_CLOSE_QUEUE = "kiosk.close";

/** What a close job carries: the sitting (the pairing's id), its project when known, and why it ended. */
export interface SittingCloseJob {
  sitting: string;
  projectId: string | null;
  cause: SittingCloseCause;
}

interface Log {
  error(obj: object, msg: string): void;
}

let door: { queue: JobQueue; log: Log } | null = null;

export function openSittingCloses(queue: JobQueue, log: Log): void {
  door = { queue, log };
}

export function closeSittingCloses(): void {
  door = null;
}

/** Whether a close can be enqueued; otherwise the sweep closes inline. */
export const sittingClosesQueued = (): boolean => door !== null;

/**
 * A project sitting: a consumed pairing that names no evaluation. Its
 * `project_id` may be null — the project deleted since (`ON DELETE SET
 * NULL`) — and it is a project sitting all the same.
 */
const projectSitting = (): SQL =>
  and(eq(kioskPairings.state, "consumed"), isNull(kioskPairings.evaluationId))!;

/** A project sitting whose portal session is not known closed yet. */
const unclosed = (): SQL => and(projectSitting(), isNull(kioskPairings.closeCompletedAt))!;

/**
 * Enqueues the close of each of `sittings` not closed and not already
 * requested, the request marked first (`close_requested_at`) so that the
 * sweep does not enqueue it again. An enqueue that fails gives the mark back:
 * the sweep's next pass tries again. Never throws into the caller — the end
 * that asked has happened. Nothing without a queue: the sweep then closes
 * inline.
 */
export async function requestSittingCloses(
  db: Db,
  sittings: readonly string[],
  cause: SittingCloseCause,
  now: Date,
): Promise<void> {
  const box = door;
  if (!box || sittings.length === 0) return;
  try {
    const claimed = await db
      .update(kioskPairings)
      .set({ closeRequestedAt: now })
      .where(and(inArray(kioskPairings.id, [...sittings]), unclosed(), isNull(kioskPairings.closeRequestedAt)))
      .returning({ sitting: kioskPairings.id, projectId: kioskPairings.projectId });
    for (const { sitting, projectId } of claimed) {
      try {
        await box.queue.send<SittingCloseJob>(KIOSK_CLOSE_QUEUE, { sitting, projectId, cause });
      } catch (err) {
        box.log.error({ err, sitting }, "kiosk close enqueue failed");
        await db.update(kioskPairings).set({ closeRequestedAt: null }).where(eq(kioskPairings.id, sitting));
      }
    }
  } catch (err) {
    box.log.error({ err }, "kiosk close request failed");
  }
}

/**
 * An administrator's Retire, or Reactivate, of a station (amendment point
 * 4, "Retries exhausted"): every sitting of the station still unclosed and
 * without a session has its close asked for again, the job that gave up
 * included. Only a completed close lifts the hold.
 */
export async function retryStationCloses(db: Db, deviceId: string, now: Date): Promise<void> {
  const rows = await db
    .update(kioskPairings)
    .set({ closeRequestedAt: null })
    .where(and(eq(kioskPairings.deviceId, deviceId), unclosed(), sittingWithoutSession()))
    .returning({ sitting: kioskPairings.id });
  await requestSittingCloses(
    db,
    rows.map((r) => r.sitting),
    "retired",
    now,
  );
}

/**
 * Whether a station is held (amendment point 4, "The hold"): it has a
 * project sitting whose close has not completed — live or ended — and
 * cannot be paired, for an exam too, until it has.
 */
export async function stationHeld(db: Db, deviceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: kioskPairings.id })
    .from(kioskPairings)
    .where(and(eq(kioskPairings.deviceId, deviceId), unclosed()))
    .limit(1);
  return row !== undefined;
}

/**
 * The sweep's safety net: the project sittings with no session left, no
 * completed close and no close requested — a cascade, or any path that
 * removed a session without asking.
 */
export async function forgottenSittings(db: Db): Promise<{ sitting: string; projectId: string | null }[]> {
  return db
    .select({ sitting: kioskPairings.id, projectId: kioskPairings.projectId })
    .from(kioskPairings)
    .where(and(unclosed(), isNull(kioskPairings.closeRequestedAt), sittingWithoutSession()));
}

/** No session row points to the pairing: the sitting has ended. */
const sittingWithoutSession = (): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM ${sessions} WHERE ${sessions.kioskPairingId} = ${kioskPairings.id})`;
