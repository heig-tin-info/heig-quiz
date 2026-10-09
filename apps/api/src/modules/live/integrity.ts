/**
 * The integrity journal (ADR-088): what is stored, and for how long.
 *
 * {@link storesIntegrityEvent} is the one rule of what is written. The
 * retention (N-DATA-03): the rows of
 * `INTEGRITY_EVENT_KINDS` — leaving the page and pasting from outside it — are
 * a hint for the time of the exam and of its correction, never a record to
 * keep. They are deleted at the release of the grades, in the release's
 * transaction ({@link purgeIntegrityJournal}), and, for an evaluation never
 * released, six months after it closed ({@link purgeAbandonedIntegrityJournal}).
 *
 * Every other kind stays: `run` carries the Run rate limit
 * (`countRecentEvents`), and `reconnect`, `ip_change`, `time_added`,
 * `paused`, `resumed` are the sitting's own history.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, type SQLWrapper } from "drizzle-orm";

import { INTEGRITY_EVENT_KINDS } from "@quiz/contracts";
import { integrityJournalOn } from "@quiz/domain";

import { delegated, type SessionAuth } from "../../auth/session.js";
import type { Db, Tx } from "../../db/client.js";
import { attemptEvents, attempts, evaluations } from "../../db/schema.js";
import { settingsOf, type EvaluationRecord } from "../evaluation/service.js";
import { countRecentEvents, logAttemptEvent } from "./autosave.js";

/**
 * Whether an integrity event sent through this session is stored: only while
 * the evaluation keeps the journal (`logVisibility`, never a poll), and never
 * from a delegated session (ADR-034: somebody else is looking). A confined
 * session (`seb`, `kiosk`) journals like a portal one: the conditions line
 * announces the journal there too. Otherwise the route still answers 204:
 * the client learns nothing from the refusal.
 */
export function storesIntegrityEvent(
  evaluation: EvaluationRecord,
  auth: Pick<SessionAuth, "actorUserId"> | null,
): boolean {
  return integrityJournalOn(evaluation.mode, settingsOf(evaluation).logVisibility) && !delegated(auth);
}

/** At most this many pastes of an attempt are stored a minute; the rest are dropped. */
export const PASTES_PER_MINUTE = 30;
/** A paste this soon after the student came back to the page follows a focus loss. */
const AFTER_FOCUS_LOSS_MS = 60_000;

type JournalRow = Pick<typeof attemptEvents.$inferSelect, "kind" | "details" | "at">;

/**
 * ADR-088 §4: whether a paste at `now` follows a focus loss, read from the
 * attempt's latest `visibility` or `focus` entry `last` — an absence still
 * open (the tab hidden, the window blurred), or a return to the page received
 * within {@link AFTER_FOCUS_LOSS_MS}. Server times only: the client never
 * says.
 */
function followsFocusLoss(last: JournalRow | undefined, now: Date): boolean {
  if (last === undefined) return false;
  const details = (last.details ?? {}) as { state?: string; focused?: boolean };
  const away = last.kind === "visibility" ? details.state === "hidden" : details.focused === false;
  return away || now.getTime() - last.at.getTime() <= AFTER_FOCUS_LOSS_MS;
}

/**
 * Stores a paste of `length` characters (ADR-088 §4) with the flag the
 * server derives, or drops it once {@link PASTES_PER_MINUTE} were stored
 * since `since`: the journal is a hint, a burst of pastes adds nothing a
 * teacher needs, and the route answers 204 either way. The pasted text never
 * reaches the server.
 */
export async function recordPaste(db: Db, attemptId: string, length: number, now: Date, since: Date): Promise<void> {
  if ((await countRecentEvents(db, attemptId, "paste", since)) >= PASTES_PER_MINUTE) return;
  const [last] = await db
    .select({ kind: attemptEvents.kind, details: attemptEvents.details, at: attemptEvents.at })
    .from(attemptEvents)
    .where(
      and(
        eq(attemptEvents.attemptId, attemptId),
        inArray(attemptEvents.kind, ["visibility", "focus"]),
        lte(attemptEvents.at, now),
      ),
    )
    .orderBy(desc(attemptEvents.at))
    .limit(1);
  await logAttemptEvent(db, attemptId, "paste", { length, afterFocusLoss: followsFocusLoss(last, now) }, now);
}

/** How long after its close an evaluation never released keeps its journal. */
const INTEGRITY_BACKSTOP_MONTHS = 6;

/** THE delete: the integrity rows of the attempts `attemptIds` selects; how many went. */
async function deleteIntegrityRows(db: Db | Tx, attemptIds: SQLWrapper): Promise<number> {
  const deleted = await db
    .delete(attemptEvents)
    .where(and(inArray(attemptEvents.kind, [...INTEGRITY_EVENT_KINDS]), inArray(attemptEvents.attemptId, attemptIds)))
    .returning({ id: attemptEvents.id });
  return deleted.length;
}

/** Deletes the integrity journal of every attempt of `evaluationId`; how many rows went. */
export function purgeIntegrityJournal(db: Db | Tx, evaluationId: string): Promise<number> {
  return deleteIntegrityRows(
    db,
    db.select({ id: attempts.id }).from(attempts).where(eq(attempts.evaluationId, evaluationId)),
  );
}

/**
 * The backstop: the integrity journal of the evaluations closed more than
 * {@link INTEGRITY_BACKSTOP_MONTHS} months before `now` and never released.
 * A condition re-read at every pass, so a missed run is caught up by the next.
 */
export function purgeAbandonedIntegrityJournal(db: Db, now: Date): Promise<number> {
  const before = new Date(now);
  before.setUTCMonth(before.getUTCMonth() - INTEGRITY_BACKSTOP_MONTHS);
  return deleteIntegrityRows(
    db,
    db
      .select({ id: attempts.id })
      .from(attempts)
      .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
      .where(and(isNull(evaluations.releasedAt), isNotNull(evaluations.closedAt), lt(evaluations.closedAt, before))),
  );
}
