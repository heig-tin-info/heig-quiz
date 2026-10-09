/**
 * Taking an evaluation: the failures, deadlines, participants (users and
 * guests), attempt creation, item order, the three views, entering, the
 * write gate every student write passes, submitting, and the per-attempt
 * close/reopen (PLAN-MVP §4.4, §4.7). Imported through `./service.ts`.
 */
import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { and, asc, count, desc, eq, inArray } from "drizzle-orm";

import {
  EvaluationSettings,
  evaluationConditionsOf,
  type AttemptClosed,
  type AttemptScore,
  type AttemptItem,
  type AttemptOrLobby,
  type AttemptView,
  type EvaluationCard,
  type EvaluationConditions,
  type EvaluationRules,
  type LobbyView,
  type ReadyView,
  type StudentPollCard,
} from "@quiz/contracts";
import { shuffle, streamSeed } from "@quiz/core/rng";
import {
  evaluationTotal,
  attemptDeadline,
  bonusSeconds,
  isFinishedAttempt,
  isWritable,
  latestAttempt,
  acquiredItems,
  lockedItems,
  partialRetakeRefusal,
  retakeRefusal,
  retakeScopeOf,
  type RetakeRefusal,
  type RetakeScope,
} from "@quiz/domain";

import { iso, isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { answers, attempts, enrollments, evaluations, guestParticipants } from "../../db/schema.js";
import { rateLimited, refusalClass, type FailureArms, type Refusal } from "../http.js";
import {
  feedbackOf,
  gradeDefaults,
  classroomIdOf,
  seatsOf,
  trustedClients,
  settingsOf,
  type DbOrTx,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import {
  isLatestAttempt,
  itemCountsByEvaluation,
  joinedItems,
  parameterizedItems,
  retakePolicyOf,
  retakesEnabled,
  studentEvaluationRows,
  totalPointsByEvaluation,
} from "../evaluation/service.js";
import { endAttempts, seated } from "./dwell.js";
import { endKioskSessions } from "../../auth/session.js";
import * as events from "./events.js";
import { enqueueEvaluationGrading } from "../grading/jobs.js";
import {
  copyGradings,
  scoreOf,
  standDownAutomaticGradings,
  standingsOf,
  studentAttempts,
  tallyByAttempt,
  validatedOfAttempt,
  type GradingRecord,
} from "../grading/service.js";
import { presence } from "../realtime/presence.js";
import {
  countedAttempt,
  countedAttemptId,
  gradeReadable,
  releasedGradesOf,
  resultsState,
  scoreVisible,
  type ReleasedGrade,
} from "../results/service.js";
import { isShuffleable, studentView } from "./studentView.js";
import type { StoredInstance } from "../../db/columns.js";
import { instanceOf, itemInstance, type InstanceAttempt } from "../pool/service.js";

export type AttemptRecord = typeof attempts.$inferSelect;

export type AnswerRecord = typeof answers.$inferSelect;

/** The teacher preview borrows a fixed attempt id: nothing is ever stored on it. */
export const PREVIEW_ATTEMPT_ID = "00000000-0000-4000-8000-000000000000";

// --- Failures -------------------------------------------------------------

/**
 * Everything this module refuses, by code: its status and, where the
 * refusal reads the same wherever it is thrown, its message.
 */
const REFUSALS = {
  // The 410 of §4.7, `AttemptClosedError`.
  attempt_closed: [410],
  // Reopening gives a student their paper back, which only means something
  // while the evaluation still takes writes: `running` or `paused`; anywhere
  // else a reopened attempt would be `in_progress` and yet unusable (#95).
  evaluation_not_live: [409, "the evaluation is not running or paused"],
  // Extra time on a finished evaluation (`closed`, `released`) moves a
  // deadline nobody can use any more; the dashboard offers no `+N min` there.
  evaluation_finished: [409, "the evaluation is already closed"],
  // `RetakeRefused`.
  retake_refused: [409],
  // ADR-091: a question a partial retake carried over is the previous
  // attempt's, as it stood: no write of any kind reaches it.
  item_acquired: [409, "this question was acquired in the previous attempt and is kept as it is"],
  // An exercise that allows several attempts reopens none (ADR-025): the
  // student starts another attempt instead, which is what retakes are for.
  retakes_enabled: [409, "this exercise allows retakes: the student starts a new attempt"],
  // ADR-050: a reopened student would rewrite their answers with the
  // correction in hand.
  correction_published: [409, "the correction of this exercise is published: no attempt is reopened"],
  not_open: [409, "this evaluation is not open"],
  // `AnswerInvalid`.
  answer_invalid: [422],
  irreversible: [409, "a validated question cannot be re-opened"],
  // "I won't answer" on a question that holds an answer (#89): skipping is
  // not a way to throw an answer away.
  answered: [409, "this question holds an answer"],
  // `done: true` where there is nothing to validate: a `free` evaluation, or
  // a question that is not a checkpoint in `milestones` (#89).
  not_validatable: [409, "this question has no validation step"],
  item_locked: [409, "navigation does not allow going back to this question"],
  // `RateLimited`.
  rate_limited: [429],
  // `RunnerDown`.
  runner_unavailable: [503],
  not_runnable: [422, "this question type has nothing to run"],
  // The type CAN run, and this answer has nothing to run (an empty
  // schematic, a circuit with no stimulus): the player says "draw something
  // first" rather than "the simulator is down".
  nothing_to_run: [422, "this answer has nothing to run yet"],
  not_found: [404],
  not_implemented: [501],
  internal_error: [500],
} satisfies Record<string, Refusal>;

export type LiveErrorCode = keyof typeof REFUSALS;

export class LiveError extends refusalClass("LiveError", REFUSALS) {}

/** The 410 of §4.7. The body carries the reason AND the server's clock. */
export class AttemptClosedError extends LiveError {
  constructor(
    readonly reason: AttemptClosed["reason"],
    readonly deadlineAt: Date | null,
  ) {
    super("attempt_closed", `attempt closed: ${reason}`);
  }
  body(now: Date): AttemptClosed {
    return {
      error: "attempt_closed",
      reason: this.reason,
      deadlineAt: isoOrNull(this.deadlineAt),
      serverNow: iso(now),
    };
  }
}

/**
 * F-EVAL-15: a retake the rule refuses (`@quiz/domain#retakeRefusal`), or a
 * retake of the questions to review `partialRetakeRefusal` refuses
 * (ADR-091). The reason travels in the body, so the screens can say which.
 */
export class RetakeRefused extends LiveError {
  constructor(readonly reason: RetakeRefusal) {
    super("retake_refused", `retake refused: ${reason}`, { reason });
  }
}

/**
 * Why no finished attempt of this evaluation may be reopened, whatever its
 * state: the rule `reopenAttempt` applies and the live grid reads
 * (`DashboardView.evaluation.reopenable`), so the grid never offers a
 * refused Reopen.
 */
export function reopenRefusal(
  evaluation: EvaluationRecord,
): "retakes_enabled" | "correction_published" | null {
  if (retakesEnabled(evaluation)) return "retakes_enabled";
  if (evaluation.correctionPublishedAt !== null) return "correction_published";
  return null;
}

export class AnswerInvalid extends LiveError {
  constructor(readonly issues: unknown) {
    super("answer_invalid");
  }
}

/** A 429 with its `Retry-After`. */
export class RateLimited extends LiveError {
  constructor(readonly retryAfterS: number) {
    super("rate_limited");
  }
}

/**
 * `reason` beside `message`: the player names the failure with it ("busy",
 * "not_configured", "timeout") without parsing a sentence.
 */
export class RunnerDown extends LiveError {
  constructor(readonly reason: string) {
    super("runner_unavailable", reason, { reason });
  }
}

/**
 * The failures answered in their own shape before the shared tail: the 410
 * with the server's clock, the type's issues, a `retry-after`. The `live`
 * and `poll` routes share them.
 */
export const liveFailureArms: FailureArms = (reply, error, now) => {
  if (error instanceof AttemptClosedError) return reply.code(410).send(error.body(now));
  if (error instanceof AnswerInvalid) return reply.code(422).send({ error: error.code, details: error.issues });
  if (error instanceof RateLimited) return rateLimited(reply, error.retryAfterS);
  return null;
};

// --- Deadlines ------------------------------------------------------------

interface DeadlineParts {
  deadlineAt: Date | null;
  bonusS: number;
}

/**
 * The ONE place an attempt deadline is computed (§10). `startedAt` is the
 * student's own start in `duration` timing, and is ignored in `deadline`
 * timing, where the anchor is `closesAt` as it stands and the base of the
 * bonus is the announced window, extensions and pauses taken out (decision
 * D8, #253).
 */
function deadlineFor(
  evaluation: EvaluationRecord,
  input: { startedAt: Date; timeBonusPercent: number; extraS: number },
): DeadlineParts {
  const settings = settingsOf(evaluation);
  const base = {
    timing: settings.timing,
    durationS: evaluation.durationS,
    opensAt: evaluation.opensAt,
    closesAt: evaluation.closesAt,
    closesAtShiftS: evaluation.closesAtShiftS,
    timeBonusPercent: input.timeBonusPercent,
  };
  return {
    deadlineAt: attemptDeadline({ ...base, startedAt: input.startedAt, extraS: input.extraS }),
    bonusS: Math.round(bonusSeconds(base)),
  };
}

// --- Access ---------------------------------------------------------------

/**
 * Who holds an attempt. EXACTLY one of the two ids is set — the check
 * constraint `attempts_owner_ck` says the same thing in the schema:
 *   - `userId`: an account, reached through a claimed roster seat for an
 *     exam or an exercise, or through the poll's own code (ADR-014);
 *   - `guestId`: a browser that joined an anonymous poll and nothing else
 *     (F-AUTH-05). A guest has no accommodation, hence no time bonus.
 */
export interface Participant {
  userId: string | null;
  guestId: string | null;
  timeBonusPercent: number;
}

/** The half of {@link Participant} an `attempts` row is keyed on. */
function ownerOf(participant: Participant): { userId: string | null; guestId: string | null } {
  return { userId: participant.userId, guestId: participant.guestId };
}

/** A student reaches an evaluation only through a CLAIMED roster seat. */
export async function participantOf(
  db: Db,
  evaluation: EvaluationRecord,
  userId: string,
): Promise<Participant | null> {
  const [row] = await db
    .select({ timeBonusPercent: enrollments.timeBonusPercent })
    .from(enrollments)
    .where(
      and(
        seatsOf(evaluation),
        eq(enrollments.userId, userId),
      ),
    )
    .limit(1);
  return row ? { userId, guestId: null, timeBonusPercent: row.timeBonusPercent } : null;
}

/**
 * ADR-027: the evaluation a `.seb` opens — one that accepts Safe Exam
 * Browser (`trustedClients`, ADR-051 §2) and in which `userId` holds a seat —
 * or `null`. Checked when the
 * file is issued AND when it is used, minutes later.
 */
export async function sebSeat(
  db: Db,
  userId: string,
  evaluationId: string,
): Promise<EvaluationRecord | null> {
  const [evaluation] = await db.select().from(evaluations).where(eq(evaluations.id, evaluationId));
  if (!evaluation || !trustedClients(evaluation).includes("seb")) return null;
  return (await participantOf(db, evaluation, userId)) ? evaluation : null;
}

/**
 * Who holds an existing attempt: the account's claimed seat when there is
 * one, and otherwise the row's own owner with no time bonus — a guest, or an
 * account whose seat has gone since.
 */
async function participantOfAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
): Promise<Participant> {
  const seat =
    attempt.userId === null ? null : await participantOf(db, evaluation, attempt.userId);
  return seat ?? { userId: attempt.userId, guestId: attempt.guestId, timeBonusPercent: 0 };
}

/**
 * The caller's own seat in the classroom of an evaluation, or `null`.
 *
 * `staff` is what tells a teacher's test walk apart from a student's attempt
 * (ADR-018): it is written by `POST /classrooms/:id/self-enroll` and it is
 * the only thing that makes the reset route of this module legitimate.
 */
async function seatOf(
  db: Db,
  evaluation: EvaluationRecord,
  userId: string,
): Promise<{ staff: boolean } | null> {
  const [row] = await db
    .select({ staff: enrollments.staff })
    .from(enrollments)
    .where(
      and(
        seatsOf(evaluation),
        eq(enrollments.userId, userId),
      ),
    )
    .limit(1);
  return row ? { staff: row.staff } : null;
}

/**
 * ADR-018: a teacher throws away their OWN test attempt to walk the quiz
 * again. `POST /evaluations/:id/attempt` is idempotent per participant, so
 * without this a teacher tests a quiz exactly once, for ever.
 *
 * Three conditions, all of them loaded rather than checked afterwards
 * (invariant 6): the seat exists, the seat is STAFF, and the attempt is the
 * caller's own. The dependent rows (answers, journal, gradings) go with it
 * through the `ON DELETE CASCADE` of the schema.
 */
export async function resetOwnStaffAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  userId: string,
): Promise<{ deleted: boolean; attemptId: string | null }> {
  const seat = await seatOf(db, evaluation, userId);
  if (!seat?.staff) return { deleted: false, attemptId: null };
  const [row] = await db
    .delete(attempts)
    .where(and(eq(attempts.evaluationId, evaluation.id), eq(attempts.userId, userId)))
    .returning({ id: attempts.id });
  if (!row) return { deleted: false, attemptId: null };
  events.attemptRemoved(evaluation.id, userId);
  return { deleted: true, attemptId: row.id };
}

/**
 * F-LIVE-02: the denominator of the lobby ring — the SEATS IN THE ROOM.
 *
 * The class, plus the staff seats that hold an attempt on this evaluation.
 * That is exactly the row set `dashboardView` builds, so the ring and the
 * grid can never disagree on who is expected, and a teacher walking their own
 * quiz (ADR-018) never reads "1 / 0" on the one screen where being counted is
 * the whole message.
 *
 * It does NOT weaken decision 4 of ADR-018: a staff attempt still counts in
 * no statistic — not in the completion of a question, not in its success
 * rate, not in the class figures. Presence is not a statistic; it is how many
 * people are sitting in the room, and a teacher sitting the quiz is one of
 * them. A staff seat that took no attempt is listed nowhere and counted
 * nowhere, exactly as before.
 */
export async function enrolledCount(db: Db, evaluation: EvaluationRecord): Promise<number> {
  return (await enrolledCounts(db, [evaluation])).get(evaluation.id) ?? 0;
}

/**
 * {@link enrolledCount} for several evaluations in two grouped statements,
 * whatever their number: the class seats per classroom, the staff seats that
 * took an attempt per evaluation.
 */
export async function enrolledCounts(
  db: Db,
  rows: readonly EvaluationRecord[],
): Promise<Map<string, number>> {
  if (rows.length === 0) return new Map();
  // An anonymous poll (or a template) has no classroom, and so no seat to count.
  const classroomIds = [
    ...new Set(rows.flatMap((r) => (r.classroomId === null ? [] : [r.classroomId]))),
  ];
  const klass = await db
    .select({ classroomId: enrollments.classroomId, n: count() })
    .from(enrollments)
    .where(and(inArray(enrollments.classroomId, classroomIds), eq(enrollments.staff, false)))
    .groupBy(enrollments.classroomId);
  const staff = await db
    .select({ evaluationId: attempts.evaluationId, n: count() })
    .from(enrollments)
    .innerJoin(
      attempts,
      // A staff seat is ONE person in the room, however many attempts.
      and(
        eq(attempts.userId, enrollments.userId),
        inArray(attempts.evaluationId, rows.map((r) => r.id)),
        isLatestAttempt,
      ),
    )
    .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
    .where(and(eq(enrollments.classroomId, evaluations.classroomId), eq(enrollments.staff, true)))
    .groupBy(attempts.evaluationId);
  const byClassroom = new Map(klass.map((k) => [k.classroomId, k.n]));
  const byEvaluation = new Map(staff.map((s) => [s.evaluationId, s.n]));
  return new Map(
    rows.map((r) => [r.id, (byClassroom.get(r.classroomId ?? "") ?? 0) + (byEvaluation.get(r.id) ?? 0)]),
  );
}


// --- Guest participants (F-AUTH-05) ----------------------------------------

type GuestRecord = typeof guestParticipants.$inferSelect;

/**
 * A poll's guest (F-AUTH-05): a browser that holds the `quiz_guest` cookie
 * (`modules/poll`). What the database holds is `sha256(token:evaluation)`.
 *
 * Binding the hash to the evaluation is what lets ONE cookie serve a browser
 * across several polls — one row per (evaluation, browser), as the unique
 * index on `token_hash` requires — and what stops a hash read out of one
 * poll's table from being replayed as another poll's participant.
 */
function guestHash(token: string, evaluationId: string): string {
  return createHash("sha256").update(`${token}:${evaluationId}`).digest("hex");
}

export async function guestByToken(
  db: Db,
  evaluationId: string,
  token: string,
): Promise<GuestRecord | null> {
  const [row] = await db
    .select()
    .from(guestParticipants)
    .where(eq(guestParticipants.tokenHash, guestHash(token, evaluationId)))
    .limit(1);
  return row ?? null;
}

/** Idempotent: the same cookie always lands on the same guest row. */
export async function ensureGuest(
  db: Db,
  evaluationId: string,
  token: string,
  now: Date,
): Promise<GuestRecord> {
  await db
    .insert(guestParticipants)
    .values({
      id: randomUUID(),
      evaluationId,
      tokenHash: guestHash(token, evaluationId),
      createdAt: now,
    })
    .onConflictDoNothing({ target: guestParticipants.tokenHash });
  const row = await guestByToken(db, evaluationId, token);
  if (!row) throw new LiveError("internal_error", "guest vanished after insert");
  return row;
}

// --- Attempts -------------------------------------------------------------

export async function attemptById(db: Db, id: string): Promise<AttemptRecord | null> {
  const [row] = await db.select().from(attempts).where(eq(attempts.id, id)).limit(1);
  return row ?? null;
}

/**
 * The participant's CURRENT attempt: the latest one (F-EVAL-15). Everything
 * a student enters, resumes or reads back is this one; the earlier attempts
 * of an exercise are only reached by id.
 */
export async function attemptOf(
  db: Db,
  evaluationId: string,
  owner: string | Participant,
): Promise<AttemptRecord | null> {
  const { userId, guestId } =
    typeof owner === "string" ? { userId: owner, guestId: null } : ownerOf(owner);
  const [row] = await db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.evaluationId, evaluationId),
        guestId === null ? eq(attempts.userId, userId!) : eq(attempts.guestId, guestId),
      ),
    )
    .orderBy(desc(attempts.attemptNumber))
    .limit(1);
  return row ?? null;
}

/**
 * A 32-bit seed, drawn once per attempt and never stored per permutation
 * (D19) — and once per drill review (ADR-041 §10, (i)).
 */
export function drawSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/**
 * The values of every parameterized item of a new attempt (ADR-056 §5),
 * drawn ONCE, here, from the attempt's seed and stored with it: the paper is
 * rendered from the seed alone before any answer exists, so the values
 * cannot wait for one. `{}` when no item declares variables — the common
 * case, which costs one indexed read.
 */
async function drawInstances(
  db: DbOrTx,
  evaluation: EvaluationRecord,
  seed: number,
): Promise<Record<string, StoredInstance>> {
  // A poll never holds a parameterized question (ADR-056 §10): nothing to read.
  if (evaluation.mode === "poll") return {};
  const items = await parameterizedItems(db, evaluation.id);
  const out: Record<string, StoredInstance> = {};
  for (const item of items) {
    const { stored } = instanceOf(item.question.type, item.version, { seed, itemId: item.item.id });
    if (stored !== null) out[item.item.id] = stored;
  }
  return out;
}

/**
 * Idempotent creation of the FIRST attempt. The unique index
 * `(evaluation_id, user_id, attempt_number)` is the mechanism: a second call
 * inserts number 1 again, is refused, and reads the row that is already
 * there, so two tabs opened at the same second share one seed, one start and
 * one deadline. A retake is {@link retakeAttempt}, never this.
 *
 * It is called only once the participant is admitted (ADR-076): by the lobby
 * or paused entry, by a trusted client's entry, or by the explicit Start
 * (`enterEvaluation` with `start`) — never by a mere look at a running evaluation,
 * which answers the ready screen and writes nothing.
 */
export async function ensureAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  participant: Participant,
  now: Date,
): Promise<AttemptRecord> {
  // `returning()` is what tells the two apart: an empty array means the
  // unique index refused the insert, so this call created nothing and must
  // not announce a new row to the dashboard.
  const seed = drawSeed();
  const created = await db
    .insert(attempts)
    .values({
      id: randomUUID(),
      evaluationId: evaluation.id,
      ...ownerOf(participant),
      state: "not_started",
      seed,
      instances: await drawInstances(db, evaluation, seed),
      presentAt: now,
      createdAt: now,
      updatedAt: now,
    })
    // A guest is keyed on `(evaluation_id, guest_id)`, an account on
    // `(evaluation_id, user_id, attempt_number)` and on its one unfinished
    // attempt: whichever index refuses, the same idempotency. No target, so
    // the partial index of the unfinished attempt counts too.
    .onConflictDoNothing()
    .returning({ id: attempts.id });
  const row = await attemptOf(db, evaluation.id, participant);
  if (!row) throw new LiveError("internal_error", "attempt vanished after insert");
  // F-DASH-03: the teacher's grid learns the row exists the moment it does,
  // not at the next refetch. A guest has no roster row to light up.
  if (created.length > 0 && row.userId !== null) {
    events.attemptRowChanged(evaluation.id, row);
    // A STAFF seat has no row in the grid until it holds an attempt (ADR-018,
    // decision 3), so the frame above has nothing to land on: the grid is one
    // ROW short, not one cell stale. There is no typed frame for a row that
    // came into existence, so the dashboards re-read — the same answer
    // `attemptRemoved` gives for a row that ceased to exist.
    const seat = await seatOf(db, evaluation, row.userId);
    if (seat?.staff) events.rosterChanged(evaluation.id);
  }
  return row;
}

/** What a partial retake carries over: the items, and their validated gradings as read. */
interface Carried {
  itemIds: string[];
  gradings: GradingRecord[];
}

/**
 * ADR-091 §3: what a partial retake carries over from `latest` — the
 * acquired items in the evaluation's order, and their validated gradings,
 * read ONCE here and copied as read — refused (`409 retake_refused`,
 * `scope_all` or `nothing_to_review`) unless the teacher chose that scope
 * and something is left to review.
 */
async function carriedFrom(
  tx: DbOrTx,
  evaluation: EvaluationRecord,
  latest: AttemptRecord,
): Promise<Carried> {
  const validated = await validatedOfAttempt(tx, latest.id);
  const standings = standingsOf(await joinedItems(tx, evaluation.id), validated);
  const refusal = partialRetakeRefusal({
    mode: evaluation.mode,
    retakes: retakePolicyOf(evaluation),
    items: standings,
  });
  if (refusal !== null) throw new RetakeRefused(refusal);
  const itemIds = acquiredItems(standings);
  return { itemIds, gradings: validated.filter((g) => itemIds.includes(g.itemId)) };
}

/**
 * ADR-091 §3: copies onto the new attempt `to` the answer of each carried
 * item from `from`, then the validated gradings `carried` read — new ids, the
 * same payload. The copy was shown when the original was (`firstShownAt`),
 * and has spent no time on screen in this attempt (dwell 0, ADR-039); a flag
 * or a validation of attempt n is not carried, they were notes on another
 * paper.
 */
async function carryAcquired(
  tx: DbOrTx,
  from: AttemptRecord,
  to: AttemptRecord,
  carried: Carried,
  now: Date,
): Promise<void> {
  if (carried.itemIds.length === 0) return;
  const originals = await tx
    .select()
    .from(answers)
    .where(and(eq(answers.attemptId, from.id), inArray(answers.itemId, carried.itemIds)));
  const copies = originals.map((answer) => ({
    ...answer,
    id: randomUUID(),
    attemptId: to.id,
    markedDone: false,
    flagged: false,
    dwellMs: 0,
    updatedAt: now,
  }));
  if (copies.length > 0) await tx.insert(answers).values(copies);
  const answerIds = new Map(copies.map((copy) => [copy.itemId, copy.id]));
  await copyGradings(tx, { rows: carried.gradings, toAttemptId: to.id, answerIds, now });
}

/**
 * F-EVAL-15 (ADR-025): a NEW attempt on an exercise that allows several —
 * number n + 1, a new seed (so a new item order and newly shuffled choices
 * on the same frozen versions), blank, and started at once: the rule only
 * allows it on a running evaluation.
 *
 * The server decides (`@quiz/domain#retakeRefusal`); the network allowlist
 * is checked, like every entry.
 *
 * Two clicks racing: both compute n + 1, the unique index lets one row in,
 * and the loser enters the attempt the winner opened (or, if it read after
 * the winner committed, is told `unfinished`). The partial index on the
 * unfinished attempt says the same thing a second time, in the schema.
 *
 * A retake racing the teacher's Close (review of #116): the rule is read
 * again INSIDE a transaction that holds the evaluation row `FOR SHARE`, and
 * the attempt is inserted already started in that same transaction.
 * `closeEvaluation` flips the state to `closed` BEFORE it expires the open
 * attempts, and that UPDATE needs the row lock: either it waits for the
 * retake to commit and then expires the new attempt with the others, or the
 * retake waits for the flip and reads `closed`. A blank attempt can never
 * be left open on a closed evaluation, graded 0, and kept as the "last".
 *
 * ADR-091: with `scope: "to_review"`, the questions acquired in the latest
 * attempt are carried over in the same transaction ({@link carriedFrom},
 * {@link carryAcquired}):
 * the new attempt is still a whole one — its own number, seed and deadline,
 * counted against the maximum — whose acquired questions hold attempt n's
 * values, answer and validated grading, read-only.
 */
export async function retakeAttempt(
  db: Db,
  input: {
    evaluation: EvaluationRecord;
    participant: Participant;
    /** ADR-091: every question (ADR-025's blank retake), or only those to review. */
    scope?: RetakeScope;
    now: Date;
  },
): Promise<AttemptRecord> {
  const { participant, now } = input;
  if (participant.userId === null) throw new RetakeRefused("not_allowed");
  const userId = participant.userId;

  const outcome = await db.transaction(async (tx) => {
    // The evaluation as it is NOW, locked against a concurrent state change;
    // the record the route loaded at the start of the request may be stale.
    const [evaluation] = await tx
      .select()
      .from(evaluations)
      .where(eq(evaluations.id, input.evaluation.id))
      .for("share");
    if (!evaluation) throw new RetakeRefused("not_open");
    const previous = await tx
      .select()
      .from(attempts)
      .where(and(eq(attempts.evaluationId, evaluation.id), eq(attempts.userId, userId)))
      .orderBy(asc(attempts.attemptNumber));
    const refusal = retakeRefusal({
      mode: evaluation.mode,
      retakes: retakePolicyOf(evaluation),
      evaluationState: evaluation.state,
      closesAt: evaluation.closesAt,
      now,
      attempts: previous,
    });
    if (refusal !== null) throw new RetakeRefused(refusal);
    // The rule passed, so the latest attempt exists and is finished.
    const latest = latestAttempt(previous);
    if (latest === null) throw new RetakeRefused("no_attempt");
    const carried: Carried =
      input.scope === "to_review"
        ? await carriedFrom(tx, evaluation, latest)
        : { itemIds: [], gradings: [] };

    // Started at once: `running` is the only state the rule allows, so there
    // is no lobby to wait in, and no `not_started` row a close would miss.
    const { deadlineAt, bonusS } = deadlineFor(evaluation, {
      startedAt: now,
      timeBonusPercent: participant.timeBonusPercent,
      extraS: 0,
    });
    const seed = drawSeed();
    const drawn = await drawInstances(tx, evaluation, seed);
    // ADR-091: an acquired question keeps the numbers it was acquired with;
    // the others are drawn anew, like every retake's.
    for (const itemId of carried.itemIds) {
      const kept = latest.instances[itemId];
      if (kept !== undefined) drawn[itemId] = kept;
    }
    const created = await tx
      .insert(attempts)
      .values({
        id: randomUUID(),
        evaluationId: evaluation.id,
        ...ownerOf(participant),
        attemptNumber: latest.attemptNumber + 1,
        state: "in_progress",
        seed,
        instances: drawn,
        acquiredItemIds: carried.itemIds,
        startedAt: now,
        deadlineAt,
        bonusS,
        presentAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    const row = created[0] ?? null;
    if (row !== null) await carryAcquired(tx, latest, row, carried, now);
    return { evaluation, row };
  });

  if (outcome.row === null) {
    // Lost the race: enter the attempt the winner opened, if it is still open.
    const row = await attemptOf(db, outcome.evaluation.id, participant);
    if (!row || isFinishedAttempt(row.state)) throw new RetakeRefused("unfinished");
    return row;
  }
  events.attemptStarted(outcome.evaluation, outcome.row, now);
  // The grid shows each student's latest attempt: the row now stands on
  // another attempt, with blank cells. No typed frame moves a whole row.
  events.rosterChanged(outcome.evaluation.id);
  return outcome.row;
}

/**
 * An attempt of an EXERCISE is graded alone as soon as it is finished —
 * handed in, expired, or closed by the teacher — while the exercise runs
 * (ADR-067): whatever its feedback policy, retakes or not, correction
 * published or not, its automatic cells are settled at once, so the student
 * reads points at hand-in rather than a grid of "not graded" for as long as
 * the exercise stays open. What only a person or a model can grade (an
 * essay, a diagram) stays pending until the close: no model is asked while
 * an evaluation runs (F-LLM-03). An exam is graded at its close, as before,
 * and so is everything a poll holds (nothing: a poll has no key).
 */
export async function gradeAtHandIn(
  app: FastifyInstance,
  evaluation: EvaluationRecord,
  attemptIds: readonly string[],
): Promise<void> {
  if (attemptIds.length === 0) return;
  if (evaluation.mode !== "exercise") return;
  if (evaluation.state !== "running" && evaluation.state !== "paused") return;
  await enqueueEvaluationGrading(app, {
    evaluationId: evaluation.id,
    attemptIds: [...attemptIds],
  });
}

/** `not_started → in_progress`, with the deadline computed once (§5.2). */
export async function beginAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  participant: Participant,
  now: Date,
): Promise<AttemptRecord> {
  if (attempt.state !== "not_started") return attempt;
  const { deadlineAt, bonusS } = deadlineFor(evaluation, {
    startedAt: now,
    timeBonusPercent: participant.timeBonusPercent,
    extraS: attempt.extraS,
  });
  // Conditional: two requests racing to start the same attempt produce one
  // start, and therefore one deadline.
  await db
    .update(attempts)
    .set({ state: "in_progress", startedAt: now, deadlineAt, bonusS, updatedAt: now })
    .where(and(eq(attempts.id, attempt.id), eq(attempts.state, "not_started")));
  const row = (await attemptById(db, attempt.id))!;
  events.attemptStarted(evaluation, row, now);
  return row;
}

export async function markPresent(db: Db, attemptId: string, now: Date): Promise<void> {
  await db.update(attempts).set({ presentAt: now }).where(eq(attempts.id, attemptId));
}

// --- Item order and navigation -------------------------------------------

interface OrderedItem extends JoinedItem {
  /** Rank in the student's own order; `item.position` stays canonical. */
  rank: number;
}

/**
 * F-EVAL-09. The order is derived from the attempt seed, never stored, so a
 * reload, the teacher preview and a regrade reproduce the same sequence.
 * `position` remains the canonical order for grading and CSV export.
 */
export function orderItems(
  items: readonly JoinedItem[],
  settings: EvaluationSettings,
  seed: number,
  evaluationId: string,
): OrderedItem[] {
  const ordered = settings.shuffleItems
    ? shuffle(items, streamSeed(seed, evaluationId, "items"))
    : [...items];
  return ordered.map((item, rank) => ({ ...item, rank }));
}

/**
 * Which items the server refuses a write to (F-EVAL-07, F-LIVE-08).
 *
 * `forward_only`: a validated question is closed. `milestones`: everything up
 * to and including the furthest checkpoint the student validated is closed.
 * Enforced HERE, on the server, and not only greyed out in the player — with
 * the SAME rule the player reads (`@quiz/domain#lockedItems`).
 */
export function lockedItemIds(
  settings: EvaluationSettings,
  ordered: readonly OrderedItem[],
  answered: ReadonlyMap<string, AnswerRecord>,
): Set<string> {
  return lockedItems(
    settings.navigation,
    ordered.map((o) => ({
      id: o.item.id,
      milestone: o.item.milestone,
      validated: answered.get(o.item.id)?.markedDone ?? false,
    })),
  );
}

export async function answersOf(db: Db, attemptId: string): Promise<Map<string, AnswerRecord>> {
  const rows = await db.select().from(answers).where(eq(answers.attemptId, attemptId));
  return new Map(rows.map((r) => [r.itemId, r]));
}

// --- Views ----------------------------------------------------------------

function attemptItems(
  ordered: readonly OrderedItem[],
  answered: ReadonlyMap<string, AnswerRecord>,
  locked: ReadonlySet<string>,
  /** ADR-091: the items a partial retake carried over. */
  acquired: ReadonlySet<string>,
  settings: EvaluationSettings,
  attempt: InstanceAttempt,
  defaults: Readonly<Record<string, unknown>>,
): AttemptItem[] {
  const { seed } = attempt;
  return ordered.map((entry) => {
    const answer = answered.get(entry.item.id) ?? null;
    // The student's own numbers (ADR-056): stored at the attempt's creation,
    // drawn from the same seed for a preview that stores nothing.
    const { version } = itemInstance(entry, attempt);
    return {
      id: entry.item.id,
      position: entry.item.position,
      points: entry.item.points,
      type: entry.question.type,
      milestone: entry.item.milestone,
      bonus: entry.item.bonus,
      // ADR-084: the teacher's passage before the item — an item property,
      // like the two flags above, carried by the one builder of the attempt.
      intro: entry.item.intro,
      student: studentView({
        type: entry.question.type,
        version,
        seed,
        itemId: entry.item.id,
        // Both switches must be on: the evaluation's and the question's.
        shuffle:
          settings.shuffleChoices &&
          entry.question.shuffleable &&
          isShuffleable(entry.question.type, version),
        // What the student must know before answering: `mcq`'s negative
        // marking (ADR-026).
        defaults,
      }),
      answer: answer?.payload ?? null,
      revision: answer?.revision ?? 0,
      markedDone: answer?.markedDone ?? false,
      skipped: answer?.skipped ?? false,
      flagged: answer?.flagged ?? false,
      locked: locked.has(entry.item.id),
      acquired: acquired.has(entry.item.id),
    };
  });
}

/**
 * Whether question content may travel to the student at all right now.
 *
 * Before the start the lobby is the WHOLE answer: an attempt row already
 * exists during the lobby (`enterEvaluation` creates it), and serving its
 * items would publish the exam before the teacher pressed Start. Once the
 * evaluation is over the items come back — the student payload carries no
 * key, and `readOnly` says the writes are done.
 */
function contentVisible(evaluation: EvaluationRecord, attempt: AttemptRecord): boolean {
  const { state } = evaluation;
  // A live evaluation shows its questions to a STARTED attempt only: one that
  // entered during a pause waits in the lobby until the resume begins it,
  // or it would read the whole exam on a clock that has not started.
  if (state === "running" || state === "paused") return attempt.state !== "not_started";
  return (
    state === "closed" ||
    state === "grading" ||
    state === "released"
  );
}

/** A write is only ever accepted on a running evaluation and a live attempt. */
function readOnlyFor(evaluation: EvaluationRecord, attempt: AttemptRecord): boolean {
  return !(attempt.state === "in_progress" && evaluation.state === "running");
}

/**
 * The ONE view of an attempt a student may hold: the lobby until the
 * evaluation starts, the attempt itself afterwards. Every student-facing
 * caller goes through it — `POST /evaluations/:id/attempt`,
 * `GET /attempts/:id` and the `watch=attempt:<id>` snapshot — so there is a
 * single place where "may this student see the questions yet" is decided.
 */
export async function attemptOrLobbyView(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
  /** Who holds the attempt, when the caller already loaded them; read once here otherwise. */
  holder?: Participant,
): Promise<AttemptOrLobby> {
  const participant = holder ?? (await participantOfAttempt(db, evaluation, attempt));
  if (!contentVisible(evaluation, attempt)) {
    return { kind: "lobby", view: await lobbyView(db, evaluation, participant, now) };
  }
  return { kind: "attempt", view: await attemptView(db, evaluation, attempt, now, participant) };
}

/**
 * The attempt itself. `holder` is who holds it, whose extra time the
 * conditions state (ADR-079): passed by a caller that already loaded them,
 * read here otherwise.
 */
export async function attemptView(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
  holder?: Participant,
): Promise<AttemptView> {
  const participant = holder ?? (await participantOfAttempt(db, evaluation, attempt));
  return viewOf(db, evaluation, {
    seed: attempt.seed,
    timeBonusPercent: participant.timeBonusPercent,
    instances: attempt.instances,
    acquired: attempt.acquiredItemIds,
    answered: await answersOf(db, attempt.id),
    header: {
      id: attempt.id,
      state: attempt.state,
      startedAt: isoOrNull(attempt.startedAt),
      deadlineAt: isoOrNull(attempt.deadlineAt),
      lastItemId: attempt.lastItemId,
      serverNow: iso(now),
      preview: false,
      readOnly: readOnlyFor(evaluation, attempt),
    },
  });
}

/**
 * The teacher's "see it as a student" (§4.3): a real student view, and NO
 * attempt row anywhere. Seed 0 by default, so it is stable between reloads;
 * the stateless preview of issue #75 passes the seed it drew instead, and
 * gets exactly the order and the shuffles an attempt of that seed would.
 */
export async function previewView(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
  seed = 0,
  /** The evaluation's items when the caller already read them, not read twice. */
  items?: readonly JoinedItem[],
): Promise<AttemptView> {
  return viewOf(db, evaluation, {
    seed,
    timeBonusPercent: 0,
    instances: {},
    acquired: [],
    items,
    answered: new Map(),
    header: {
      id: PREVIEW_ATTEMPT_ID,
      state: "in_progress",
      startedAt: iso(now),
      deadlineAt: null,
      lastItemId: null,
      serverNow: iso(now),
      preview: true,
      readOnly: false,
    },
  });
}

/**
 * The one builder behind {@link attemptView} and {@link previewView}: the two
 * differ only by the seed, the stored answers and the `attempt` header, so
 * both go through `attemptItems` -> `studentView` (invariant 4) by
 * construction.
 */
async function viewOf(
  db: Db,
  evaluation: EvaluationRecord,
  input: {
    seed: number;
    /** The participant's extra time, for the conditions' duration line (ADR-079); 0 in a preview. */
    timeBonusPercent: number;
    /** The attempt's stored values (ADR-056); `{}` for a preview, which draws them from `seed`. */
    instances: Readonly<Record<string, StoredInstance>>;
    /** ADR-091: the items a partial retake carried over; none in a preview. */
    acquired: readonly string[];
    items?: readonly JoinedItem[] | undefined;
    answered: ReadonlyMap<string, AnswerRecord>;
    header: AttemptView["attempt"];
  },
): Promise<AttemptView> {
  const { seed, answered } = input;
  const settings = settingsOf(evaluation);
  const items = input.items ?? (await joinedItems(db, evaluation.id));
  const ordered = orderItems(items, settings, seed, evaluation.id);
  const locked = lockedItemIds(settings, ordered, answered);
  // `AttemptView` types the settings without `conditions` (ADR-079); a
  // variable is not checked for excess keys, so they are taken out here.
  const { conditions: _announced, ...studentSettings } = settings;
  return {
    attempt: input.header,
    conditions: conditionsFor(evaluation, input.timeBonusPercent),
    evaluation: {
      id: evaluation.id,
      title: evaluation.title,
      mode: evaluation.mode,
      state: evaluation.state,
      settings: studentSettings,
      feedbackPolicy: feedbackOf(evaluation),
      pausedAt: isoOrNull(evaluation.pausedAt),
      totalPoints: evaluationTotal(items.map((i) => i.item)),
    },
    items: attemptItems(
      ordered,
      answered,
      locked,
      new Set(input.acquired),
      settings,
      { seed, instances: input.instances },
      gradeDefaults(evaluation),
    ),
  };
}

/**
 * The conditions a student reads (ADR-079): the announced ones and the lines
 * the platform derives from the settings, with this participant's extra time.
 */
function conditionsFor(evaluation: EvaluationRecord, timeBonusPercent: number): EvaluationConditions {
  return evaluationConditionsOf({
    mode: evaluation.mode,
    settings: settingsOf(evaluation),
    durationS: evaluation.durationS,
    closesAt: isoOrNull(evaluation.closesAt),
    timeBonusPercent,
  });
}

/** What both the waiting room and the ready screen state (`EvaluationRules`). */
function rulesOf(evaluation: EvaluationRecord, participant: Participant): EvaluationRules {
  return { conditions: conditionsFor(evaluation, participant.timeBonusPercent) };
}

/**
 * What the waiting room shows a student. Mirrored on the teacher's launch
 * step by `lobbyPreviewView` (`apps/web/src/evaluation/LobbyPreview.tsx`,
 * #152), and sharing its rules with the ready screen (`readyView`): a field
 * added to `EvaluationRules` belongs to all three.
 */
export async function lobbyView(
  db: Db,
  evaluation: EvaluationRecord,
  participant: Participant,
  now: Date,
): Promise<LobbyView> {
  return {
    ...rulesOf(evaluation, participant),
    evaluation: {
      id: evaluation.id,
      title: evaluation.title,
      state: evaluation.state,
    },
    present: presence.count(evaluation.id),
    enrolled: await enrolledCount(db, evaluation),
    serverNow: iso(now),
  };
}

/** What the ready screen says (ADR-076): the rules and what Start announces, no content. */
function readyView(evaluation: EvaluationRecord, participant: Participant): ReadyView {
  return {
    ...rulesOf(evaluation, participant),
    evaluation: {
      id: evaluation.id,
      title: evaluation.title,
    },
  };
}

// --- Entering an evaluation ----------------------------------------------

type EnterResult =
  | { kind: "attempt"; view: AttemptView; attempt: AttemptRecord }
  | { kind: "lobby"; view: LobbyView; attempt: AttemptRecord }
  // Nothing was written: there is no attempt row (ADR-076).
  | { kind: "ready"; view: ReadyView; attempt: null };

/**
 * `POST /evaluations/:id/attempt` and `…/attempt/start` (F-LIVE-01,
 * ADR-076). Idempotent end to end: the row, the seed and the start instant
 * are created at most once.
 *
 * Entering is not starting. On a `running` evaluation a participant with NO
 * attempt row, who did not ask to `start`, gets the ready screen and NOTHING
 * is written — no row, no presence, no clock — so a look at a link never
 * consumes an attempt. `start` is true for the explicit Start and for a
 * trusted client (`seb`, `kiosk`), whose pairing already is the explicit act.
 * A participant whose row exists begins directly, and in `lobby` and
 * `paused` the row and the presence are still created here: the waiting room
 * counts them (F-LIVE-02/03, `beginWaitingAttempts`). A retake is
 * {@link retakeAttempt}, started by its own click.
 */
export async function enterEvaluation(
  db: Db,
  input: {
    evaluation: EvaluationRecord;
    participant: Participant;
    now: Date;
    start: boolean;
  },
): Promise<EnterResult> {
  const { evaluation, participant, now, start } = input;
  // A guest (no user) only ever joins a poll, which is not entered here.
  if (evaluation.mode === "poll" || participant.userId === null) {
    throw new LiveError("not_implemented", "poll is phase 2");
  }
  // The room restriction (F-EVAL-12) is already settled: `sitRefusal`, in
  // the route's loader, refused an off-site request.

  const open = evaluation.state === "lobby" || evaluation.state === "running" ||
    evaluation.state === "paused";
  const existing = await attemptOf(db, evaluation.id, participant);
  // A closed evaluation still hands back a finished attempt: the student
  // must be able to reopen the page and see what they submitted.
  if (!open && existing === null) throw new LiveError("not_open");
  if (existing === null && evaluation.state === "running" && !start) {
    return { kind: "ready", view: readyView(evaluation, participant), attempt: null };
  }

  let attempt = existing ?? (await ensureAttempt(db, evaluation, participant, now));
  await markPresent(db, attempt.id, now);

  if (evaluation.state === "running") {
    attempt = await beginAttempt(db, evaluation, attempt, participant, now);
  }
  const view = await attemptOrLobbyView(db, evaluation, attempt, now, participant);
  return view.kind === "lobby"
    ? { kind: "lobby", view: view.view, attempt }
    : { kind: "attempt", view: view.view, attempt };
}

// --- Autosave (§4.7) ------------------------------------------------------

/**
 * How far a gate reaches, from the strictest to the loosest:
 *   - `answer`: a write to an answer. A PAUSED evaluation refuses it
 *     (decision D17: the client greys out and buffers; nothing is lost);
 *   - `presence`: the position, the journal, the sign of life. A paused
 *     evaluation allows it — the student is still in the room;
 *   - `submit`: handing the attempt in. Only the attempt's own state counts.
 */
type GateScope = "answer" | "presence" | "submit";

/**
 * THE rule of "may this attempt still be written to", as the reason it may
 * not, or `null`. The arms run in the order the plan fixes, and the grace
 * window is `GRACE_MS`, the same rule the ticker expires the attempt by —
 * the two must never drift (decision D12, invariant 5).
 */
function closedReason(
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
  scope: GateScope,
): AttemptClosed["reason"] | null {
  if (attempt.state !== "in_progress") {
    return attempt.state === "submitted" ? "submitted" : "deadline";
  }
  if (scope === "submit") return null;
  if (evaluation.state === "paused") {
    if (scope === "answer") return "paused";
  } else if (evaluation.state !== "running") {
    return "evaluation_closed";
  }
  // `@quiz/domain`'s acceptance rule, the one the ticker's cutoff is built on.
  return isWritable(attempt.deadlineAt, now) ? null : "deadline";
}

/** {@link closedReason} as the 410 of §4.7. */
function assertGate(
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
  scope: GateScope,
): void {
  const reason = closedReason(evaluation, attempt, now, scope);
  if (reason !== null) throw new AttemptClosedError(reason, attempt.deadlineAt);
}

/** The gate of an answer write. It runs BEFORE the write. */
export function assertWritable(
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
): void {
  assertGate(evaluation, attempt, now, "answer");
}

/**
 * The lighter half of {@link assertWritable}, for what is not a write to an
 * answer: the position, the journal and the sign of life.
 *
 * It allows a PAUSED evaluation — the student is still in the room, and
 * their client keeps saying so (decision D17) — and refuses everything a
 * finished attempt or a finished evaluation would otherwise keep writing:
 * a submitted student must stop refreshing `present_at` and growing the
 * journal for ever.
 */
export function isOpen(
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
): boolean {
  return closedReason(evaluation, attempt, now, "presence") === null;
}

/** {@link isOpen}, as the 410 of §4.7. */
export function assertOpen(
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
): void {
  assertGate(evaluation, attempt, now, "presence");
}

/**
 * F-LIVE-10. Terminal and irreversible for the student.
 *
 * With `app`, an exercise grades the attempt now (ADR-067) —
 * only when THIS call is the one that finished it: a repeated or concurrent
 * submit of the same attempt updates nothing and enqueues nothing.
 */
export async function submitAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
  app?: FastifyInstance,
): Promise<AttemptRecord> {
  assertGate(evaluation, attempt, now, "submit");
  // The question on screen stops counting where the attempt ends (ADR-039).
  const finished = await endAttempts(
    db,
    eq(attempts.id, attempt.id),
    { state: "submitted", closedBy: "student", submittedAt: now },
    now,
  );
  const row = (await attemptById(db, attempt.id))!;
  events.attemptClosed(evaluation.id, row, "student", now);
  await endKioskSessions(db, evaluation.id, seated(finished));
  if (app && finished.length > 0) await gradeAtHandIn(app, evaluation, [row.id]);
  return row;
}

/**
 * Closes ONE attempt without closing the evaluation (F-LIVE-11).
 *
 * Allowed whatever the state of the evaluation: an `in_progress` attempt left
 * behind in a finished evaluation (reopened after the close, before #95) must
 * stay closable. A no-op on an attempt that is already finished.
 */
export async function closeAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
  app?: FastifyInstance,
): Promise<AttemptRecord> {
  const closed = await endAttempts(
    db,
    eq(attempts.id, attempt.id),
    { state: "expired", closedBy: "teacher" },
    now,
  );
  const row = (await attemptById(db, attempt.id))!;
  events.attemptClosed(evaluation.id, row, "teacher", now);
  await endKioskSessions(db, evaluation.id, seated(closed));
  // The pass of the evaluation's close has already run, and it ran while this
  // attempt was open: grade it now, alone (the pass never touches a cell a
  // teacher validated). Not on a `released` evaluation, whose grades are
  // published: those stay the teacher's to change, from the grading panel.
  if (app && closed.length > 0 && evaluation.state === "closed") {
    await enqueueEvaluationGrading(app, { evaluationId: evaluation.id, attemptIds: [row.id] });
  } else if (app && closed.length > 0) {
    await gradeAtHandIn(app, evaluation, [row.id]);
  }
  return row;
}

/**
 * Reopens one attempt (a student closed a tab too early, a laptop died). The
 * deadline is recomputed from the ORIGINAL start plus everything already
 * granted, so reopening is not a second full duration. In `deadline` timing a
 * shift common to everybody is in `closes_at` and not in `extraS` (#252), so
 * each is counted once.
 */
export async function reopenAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
): Promise<AttemptRecord> {
  if (evaluation.state !== "running" && evaluation.state !== "paused") {
    throw new LiveError("evaluation_not_live");
  }
  if (attempt.state === "in_progress") return attempt;
  const refused = reopenRefusal(evaluation);
  if (refused === "retakes_enabled") throw new LiveError("retakes_enabled");
  if (refused === "correction_published") throw new LiveError("correction_published");
  const participant = await participantOfAttempt(db, evaluation, attempt);
  const { deadlineAt, bonusS } = deadlineFor(evaluation, {
    startedAt: attempt.startedAt ?? now,
    timeBonusPercent: participant.timeBonusPercent,
    extraS: attempt.extraS,
  });
  await db.transaction(async (tx) => {
    // The attempt's row lock, which every grading write of the jobs takes
    // too before re-reading the attempt's state (ADR-067): a pass that
    // loaded this attempt finished either commits before the stand-down
    // below (which then supersedes what it wrote) or sees it reopened.
    await tx.select({ id: attempts.id }).from(attempts).where(eq(attempts.id, attempt.id)).for("update");
    await tx
      .update(attempts)
      .set({
        state: "in_progress",
        startedAt: attempt.startedAt ?? now,
        deadlineAt,
        bonusS,
        closedAt: null,
        closedBy: null,
        submittedAt: null,
        updatedAt: now,
      })
      .where(eq(attempts.id, attempt.id));
    // An exercise graded this attempt at its hand-in (ADR-067): those grades
    // no longer describe what the student will hand in next, and the next
    // hand-in grades it again. What a teacher settled by hand stays.
    await standDownAutomaticGradings(tx, attempt.id);
  });
  const row = (await attemptById(db, attempt.id))!;
  events.deadlineChanged(evaluation, row, "reopen", now);
  return row;
}

// --- Student home (F-LIVE-01) --------------------------------------------

/**
 * The evaluations' half of the student's home and classroom page: the
 * running polls and the evaluation cards in their three groups. The
 * `activity` module tags them and lists them with the other kinds
 * (`ActivityKind.studentCards`, M3-09a); the kiosk reads them for the exams
 * a station may start (ADR-051 §7).
 */
export interface EvaluationHome {
  polls: StudentPollCard[];
  open: EvaluationCard[];
  upcoming: EvaluationCard[];
  past: EvaluationCard[];
}

/**
 * `classroomId` narrows the home to one of the student's classrooms: the
 * Activities tab of their classroom page (M5-01, `ActivityKind.studentCards`),
 * which the caller has loaded through `readableClassroom` first.
 */
export async function studentHome(
  db: Db,
  userId: string,
  now: Date,
  classroomId?: string,
): Promise<EvaluationHome> {
  const { polls, open, upcoming, past } = await studentBoard(db, userId, now, classroomId);
  return { polls, open, upcoming, past: past.map((entry) => entry.card) };
}

type StudentRow = Awaited<ReturnType<typeof studentEvaluationRows>>[number];

/**
 * A card of the student's Past, beside the row it was drawn from, the
 * attempt that counts (`countedAttempt`), the released grade, and `early`:
 * the points the feedback page shows for that attempt BEFORE the release
 * (results `available`, not released), with its count of questions still
 * pending, null everywhere else.
 */
export interface PastEntry {
  row: StudentRow;
  card: EvaluationCard;
  counted: { id: string; state: string } | null;
  released: ReleasedGrade | undefined;
  early: AttemptScore | null;
}

/**
 * The student's evaluations sorted into the home's lists (F-LIVE-01): ONE
 * rule for what is open, coming and past, which the home and the Grades page
 * (`grades.ts`) both read. Within the module only.
 */
export async function studentBoard(db: Db, userId: string, now: Date, classroomId?: string) {
  const all = await studentEvaluationRows(db, userId, classroomId).orderBy(
    desc(evaluations.createdAt),
  );

  // Issue #163: a poll is answered at `/p/:code`, never through an attempt of
  // the player (`enterEvaluation` refuses one), so it is never an evaluation
  // card. A RUNNING one is listed on its own, with its code and nothing of its
  // question; an ended one is gone, since nothing of a poll is released
  // (ADR-014 §8). The rows come through the student's roster seats, so a
  // classroom-less (anonymous) poll can never be among them.
  const polls: StudentPollCard[] = all
    .filter(
      (r) =>
        r.evaluation.mode === "poll" &&
        r.evaluation.state === "running" &&
        r.evaluation.accessCode !== null,
    )
    .map((r) => ({
      id: r.evaluation.id,
      code: r.evaluation.accessCode!,
      classroomId: classroomIdOf(r.evaluation),
      classroomName: r.classroomName,
      courseCode: r.courseCode,
    }));
  const rows = all.filter((r) => r.evaluation.mode !== "poll");

  // F-EVAL-15: an exercise with retakes shows the attempt that COUNTS (best
  // or last) and how many were taken; its grade is the kept attempt's. Every
  // other card is its one attempt, as before.
  const withRetakes = rows.filter((r) => retakesEnabled(r.evaluation));
  const perEvaluation = await studentAttempts(
    db,
    userId,
    withRetakes.map((r) => r.evaluation),
  );

  // The grade of a released evaluation is the results page's (WP6), and the
  // score of a kept attempt what its feedback page would show — so are the
  // points of a row readable before its release (`early`). A fixed number of
  // queries for the whole page, not one per card.
  const readableEarly = rows.filter((row) => {
    const kept = countedAttempt(perEvaluation, row);
    return (
      kept !== null &&
      row.evaluation.releasedAt === null &&
      resultsState(row.evaluation, kept.state) === "available"
    );
  });
  const scored = [...new Set([...withRetakes, ...readableEarly])];
  const scoredIds = [...new Set(scored.map((r) => r.evaluation.id))];
  const [grades, totals, itemCounts, keptTallies] = await Promise.all([
    releasedGradesOf(db, userId, rows, perEvaluation),
    totalPointsByEvaluation(db, scoredIds),
    itemCountsByEvaluation(db, scoredIds),
    tallyByAttempt(
      db,
      scored
        .map((row) => countedAttemptId(perEvaluation, row))
        .filter((id): id is string => id !== null),
    ),
  ]);

  const retakesOf = (row: (typeof rows)[number]): EvaluationCard["retakes"] => {
    const mine = perEvaluation.get(row.evaluation.id);
    if (!mine) return null;
    const policy = retakePolicyOf(row.evaluation);
    const kept = mine.kept;
    return {
      keep: policy.keep,
      maxAttempts: policy.maxAttempts,
      scope: retakeScopeOf(policy),
      attemptCount: mine.all.length,
      canRetake:
        retakeRefusal({
          mode: row.evaluation.mode,
          retakes: policy,
          evaluationState: row.evaluation.state,
          closesAt: row.evaluation.closesAt,
          now,
          attempts: mine.all,
        }) === null,
      // Only a finished attempt has a score to read (ADR-025).
      kept:
        kept === null || !isFinishedAttempt(kept.state)
          ? null
          : {
              attemptId: kept.id,
              attemptNumber: kept.attemptNumber,
              // What the feedback page would show, and no more.
              score: scoreVisible(row.evaluation, kept.state)
                ? scoreOf(
                    keptTallies.get(kept.id),
                    itemCounts.get(row.evaluation.id) ?? 0,
                    totals.get(row.evaluation.id) ?? 0,
                  )
                : null,
            },
    };
  };

  const card = (row: (typeof rows)[number], counted: string | null): EvaluationCard => {
    return {
      id: row.evaluation.id,
      title: row.evaluation.title,
      mode: row.evaluation.mode,
      state: row.evaluation.state,
      classroomId: classroomIdOf(row.evaluation),
      classroomName: row.classroomName,
      courseCode: row.courseCode,
      opensAt: isoOrNull(row.evaluation.opensAt),
      closesAt: isoOrNull(row.evaluation.closesAt),
      durationS: row.evaluation.durationS,
      attemptId: row.attempt?.id ?? null,
      attemptState: row.attempt?.state ?? null,
      attemptStartedAt: isoOrNull(row.attempt?.startedAt ?? null),
      deadlineAt: isoOrNull(row.attempt?.deadlineAt ?? null),
      // Only a grade the student may read (F-RES-04): never under `none`.
      grade: gradeReadable(row.evaluation, counted)
        ? (grades.get(row.evaluation.id)?.grade ?? null)
        : null,
      retakes: retakesOf(row),
      // Issue #203: what "See my results" would lead to, for the attempt
      // that counts — the results service's own rule.
      results: resultsState(row.evaluation, counted),
      trustedClients: trustedClients(row.evaluation),
      // Set on an open card only, below (`withConditions`).
      conditions: null,
    };
  };

  // ADR-079 §7: a trusted client may begin the attempt directly, past the
  // waiting room, so an OPEN card carries what that room would have said.
  // Upcoming and past cards carry none, as a plain exam's.
  const withConditions = (row: (typeof rows)[number], c: EvaluationCard): EvaluationCard =>
    c.trustedClients.length > 0 ? { ...c, conditions: conditionsFor(row.evaluation, row.timeBonusPercent) } : c;

  const open: EvaluationCard[] = [];
  const upcoming: EvaluationCard[] = [];
  const past: PastEntry[] = [];
  for (const row of rows) {
    const state = row.evaluation.state;
    if (state === "draft") continue;
    // The attempt that COUNTS (F-EVAL-15): the server's own, for the card and
    // for the Grades page alike.
    const kept = countedAttempt(perEvaluation, row);
    const counted = kept ? { id: kept.id, state: kept.state } : null;
    const c = card(row, counted?.state ?? null);
    const early =
      counted !== null && readableEarly.includes(row)
        ? scoreOf(
            keptTallies.get(counted.id),
            itemCounts.get(row.evaluation.id) ?? 0,
            totals.get(row.evaluation.id) ?? 0,
          )
        : null;
    const ended = { row, card: c, counted, released: grades.get(row.evaluation.id), early };
    if (state === "scheduled") upcoming.push(c);
    else if (state !== "lobby" && state !== "running" && state !== "paused") past.push(ended);
    // Issue #203: "Open now" is what the student can still DO. A finished
    // attempt that cannot be retaken has nothing left to do, whatever the
    // evaluation's state: it is past. A reopened attempt is `in_progress`
    // again, and comes back here on its own.
    else if (c.attemptState !== null && isFinishedAttempt(c.attemptState) && !c.retakes?.canRetake) {
      past.push(ended);
    } else open.push(withConditions(row, c));
  }
  return { polls, open, upcoming, past };
}
