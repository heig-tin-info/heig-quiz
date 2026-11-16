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
import { and, eq, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { kioskPairings, sessions } from "../../db/schema.js";
import type { JobQueue } from "../../jobs.js";

/**
 * Why a kiosk station's project sitting ended, as `codespace.session_closed`
 * records it (ADR-089 §13 and its amendment of 2026-11-15, point 4): Leave
 * this station, a newer confined session of the pair, the student's
 * effective deadline, the 6 h lifetime, the station's retirement, or any
 * other disappearance the sweep or a deletion caught — and, by the
 * amendment of 2026-11-16, a code requested by the freshly attested station
 * while the sitting was live: the station was restarted.
 */
export type SittingCloseCause = "left" | "superseded" | "deadline" | "expired" | "retired" | "swept" | "restarted";

/**
 * How long a consumed pairing waits before the sweep may take it for a
 * sitting left without a session: the station's poll consumes the pairing
 * first, and its session row appears only once the poll's checks and the
 * session's own commit are through — a window of milliseconds, given two
 * minutes.
 */
export const SITTING_START_GRACE_MS = 2 * 60_000;

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
 * inline. The mark comes first, so that a job that finds the sitting live
 * can give it back after this request; a crash between the mark and the
 * send leaves the sitting asked for with no job: the station stays held
 * until an administrator's Retire then Reactivate (ADR-089, amendment
 * point 4).
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
 * removed a session without asking —, consumed more than
 * {@link SITTING_START_GRACE_MS} ago: a sitting still starting has no
 * session yet, and is not forgotten.
 */
export async function forgottenSittings(db: Db, now: Date): Promise<{ sitting: string; projectId: string | null }[]> {
  return db
    .select({ sitting: kioskPairings.id, projectId: kioskPairings.projectId })
    .from(kioskPairings)
    .where(
      and(
        unclosed(),
        isNull(kioskPairings.closeRequestedAt),
        lte(kioskPairings.consumedAt, new Date(now.getTime() - SITTING_START_GRACE_MS)),
        sittingWithoutSession(),
      ),
    );
}

/**
 * The close's completion, atomic with the absence of a session: one UPDATE
 * that sets `close_completed_at` only while no session points to the
 * sitting. `closed` when it did; `done` when another job had; `live` when a
 * session points to it — a sitting still starting, or one reopened since
 * the job was asked for —, whose request is then given back, so that the
 * end of that session asks again (the station stays held meanwhile).
 */
export async function completeSittingClose(db: Db, sitting: string, now: Date): Promise<"closed" | "done" | "live"> {
  const [completed] = await db
    .update(kioskPairings)
    .set({ closeCompletedAt: now })
    .where(and(eq(kioskPairings.id, sitting), isNull(kioskPairings.closeCompletedAt), sittingWithoutSession()))
    .returning({ id: kioskPairings.id });
  if (completed) return "closed";
  // Another job completed it, or a session pointed to it at the UPDATE —
  // perhaps dropped since, its own request lost to the mark still set. The
  // mark is given back while the close is incomplete, so that the session's
  // end, or the sweep, asks again.
  await db
    .update(kioskPairings)
    .set({ closeRequestedAt: null })
    .where(and(eq(kioskPairings.id, sitting), isNull(kioskPairings.closeCompletedAt)));
  const [live] = await db.select({ one: sessions.sidHash }).from(sessions).where(eq(sessions.kioskPairingId, sitting)).limit(1);
  return live ? "live" : "done";
}

/**
 * Whether a session points to `sitting`; if so its close request is given
 * back (`close_requested_at` cleared), so that the end of that session asks
 * again.
 */
export async function giveBackIfLive(db: Db, sitting: string): Promise<boolean> {
  const [live] = await db.select({ one: sessions.sidHash }).from(sessions).where(eq(sessions.kioskPairingId, sitting)).limit(1);
  if (live) await db.update(kioskPairings).set({ closeRequestedAt: null }).where(eq(kioskPairings.id, sitting));
  return live !== undefined;
}

/** No session row points to the pairing: the sitting has ended. */
const sittingWithoutSession = (): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM ${sessions} WHERE ${sessions.kioskPairingId} = ${kioskPairings.id})`;
