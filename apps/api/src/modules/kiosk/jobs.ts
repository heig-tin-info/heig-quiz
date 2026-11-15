/**
 * The kiosk module's background work (ADR-006, ADR-051, ADR-089).
 *
 *  - `kiosk.silent`: the stations sitting an exam that stopped attesting are
 *    silent, hence suspended (ADR-051 §6). Once a minute is plenty against a
 *    twelve-minute threshold. Inert while the kiosk path is off.
 *  - `kiosk.sittings`: the ends of a station's project sitting the clock
 *    decides — the student's effective deadline, the 6 h — and the safety
 *    net that closes every sitting left without a session and without a
 *    close (ADR-089, amendment of 2026-11-15, point 4).
 *  - the `kiosk.close` job: one sitting's portal session closed.
 *
 * The kill switch never stops a close: `kiosk.sittings` and the close job
 * run whatever `KIOSK_ATTESTATION` and `KIOSK_PROJECTS` say, and with
 * `KIOSK_ATTESTATION=off` the sweep ends every station session of a project.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { effectiveDeadline } from "@quiz/domain";

import { audit, SYSTEM_ACTOR } from "../../audit.js";
import { endKioskSessions, sweepStationSessions } from "../../auth/session.js";
import type { AppConfig } from "../../config.js";
import { kioskPairings, projectRepos, projects, sessions } from "../../db/schema.js";
import type { JobQueue, JobTry } from "../../jobs.js";
import type { TickTask } from "../../ticker.js";
import { sendSittingClose } from "../codespace/service.js";
import {
  KIOSK_CLOSE_QUEUE,
  closeSittingCloses,
  completeSittingClose,
  forgottenSittings,
  giveBackIfLive,
  openSittingCloses,
  requestSittingCloses,
  sittingClosesQueued,
  type SittingCloseJob,
} from "./sittings.js";
import { ownRepository } from "./pairing.js";
import { sweepSilentStations } from "./watch.js";

export const KIOSK_TASKS: TickTask[] = [
  {
    name: "kiosk.silent",
    everyMs: 60_000,
    run: async (app, config) => {
      if (config.KIOSK_ATTESTATION === "off") return;
      await sweepSilentStations(app.db, app.clock.now());
    },
  },
  {
    name: "kiosk.sittings",
    everyMs: 60_000,
    run: sweepProjectSittings,
  },
];

type App = Pick<FastifyInstance, "db" | "clock" | "log">;

/**
 * The sweep of the stations' project sittings (amendment point 4), whatever
 * the flags say: every station session of a project ends while the kiosk
 * path is off, past its 6 h, or past its student's effective deadline
 * (`effectiveDeadline`, ADR-078 §2: the student's own repository's when it
 * has one, ADR-089 §8) — each drop asking for its close —; then every
 * sitting left without a session, a close or a request has its close asked
 * for (`swept`), or, without a queue, run here.
 */
export async function sweepProjectSittings(app: App, config: AppConfig): Promise<void> {
  const now = app.clock.now();
  await sweepStationSessions(app.db, now, config.KIOSK_ATTESTATION === "off");
  const seated = await app.db
    .select({
      userId: sessions.userId,
      projectId: projects.id,
      deadlineAt: projects.deadlineAt,
      repoDeadlineAt: projectRepos.deadlineAt,
    })
    .from(sessions)
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .leftJoin(projectRepos, ownRepository(sessions.userId))
    .where(and(eq(sessions.kind, "kiosk"), isNotNull(sessions.projectId)));
  const due = new Map<string, string[]>();
  for (const row of seated) {
    if (effectiveDeadline({ deadlineAt: row.repoDeadlineAt }, row).getTime() > now.getTime()) continue;
    due.set(row.projectId, [...(due.get(row.projectId) ?? []), row.userId]);
  }
  for (const [projectId, userIds] of due) await endKioskSessions(app.db, { evaluationId: null, projectId }, userIds, "deadline");

  const forgotten = await forgottenSittings(app.db, now);
  if (sittingClosesQueued()) {
    await requestSittingCloses(
      app.db,
      forgotten.map((f) => f.sitting),
      "swept",
      now,
    );
    return;
  }
  // No queue (`JOBS_DISABLED`): closed here, a failure left to the next pass.
  for (const close of forgotten) {
    try {
      await runSittingClose(app, config, { ...close, cause: "swept" }, { lastTry: false });
    } catch (err) {
      app.log.warn({ err, sitting: close.sitting }, "kiosk close failed; the next sweep tries again");
    }
  }
}

/**
 * The `kiosk.close` job: the portal told to close `sitting`
 * (`sendSittingClose`), then `close_completed_at` set — the hold lifted —
 * and `codespace.session_closed` written with the cause. Idempotent: a
 * sitting already closed is done. A sitting a session points to is not
 * closed — one still starting (the station's poll consumes the pairing
 * before its session commits), or one a job was asked for while it ran —:
 * its request is given back for the end that will come. That holds before
 * the call, and again at the completion, which is atomic with the absence
 * of a session (`completeSittingClose`): a session born while the portal was
 * told keeps the station held, and its own end closes again. A portal that
 * does not answer 204
 * throws, for the queue to retry; the last try's failure is audited
 * (`codespace.session_close_failed`) and leaves the station held until an
 * administrator's Retire then Reactivate.
 *
 * With the portal off (`sendSittingClose` answers `"off"`, no
 * `CODESPACE_URL`) the close is completed without a call: no portal session
 * can exist then — the start route is not registered, so no station got a
 * launch, and Quiz neither reaches nor frames a portal it does not know —,
 * and leaving the station held would strand it for nothing.
 */
export async function runSittingClose(
  app: App,
  config: AppConfig,
  job: SittingCloseJob,
  { lastTry }: JobTry,
): Promise<"closed" | "off" | "done" | "live"> {
  const db = app.db;
  const [pairing] = await db
    .select({ projectId: kioskPairings.projectId, closeCompletedAt: kioskPairings.closeCompletedAt })
    .from(kioskPairings)
    .where(eq(kioskPairings.id, job.sitting));
  if (pairing?.closeCompletedAt) return "done";
  if (await giveBackIfLive(db, job.sitting)) return "live";
  const projectId = pairing ? pairing.projectId : job.projectId;
  const now = app.clock.now();
  const subject = { ...SYSTEM_ACTOR, subjectType: "kiosk_pairing", subjectId: job.sitting } as const;
  let outcome: "sent" | "off";
  try {
    outcome = await sendSittingClose(config, { sitting: job.sitting, projectId }, now);
  } catch (err) {
    if (lastTry) {
      const error = err instanceof Error ? err.message : String(err);
      await audit(db, { ...subject, action: "codespace.session_close_failed", payload: { projectId, cause: job.cause, error } });
    }
    throw err;
  }
  const completed = await completeSittingClose(db, job.sitting, now);
  if (completed !== "closed") return completed;
  if (outcome === "off") return "off";
  await audit(db, { ...subject, action: "codespace.session_closed", payload: { projectId, cause: job.cause } });
  return "closed";
}

/**
 * The close's queue and worker, registered whatever the flags say (the kill
 * switch never stops a close), and the door `dropSessions` enqueues through
 * opened. Retried five times with backoff, as the portal's sync.
 */
export async function registerKioskJobs(app: FastifyInstance, queue: JobQueue, config: AppConfig): Promise<void> {
  await queue.createQueue(KIOSK_CLOSE_QUEUE, { retryLimit: 5, retryBackoff: true, retryDelay: 30 });
  await queue.work<SittingCloseJob>(KIOSK_CLOSE_QUEUE, async (job, attempt) => {
    await runSittingClose(app, config, job, attempt);
  });
  openSittingCloses(queue, app.log);
  app.addHook("onClose", async () => closeSittingCloses());
}
