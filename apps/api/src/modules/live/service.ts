/**
 * The `live` module's business layer: taking an evaluation, and driving it
 * (PLAN-MVP §4.4, §4.7, §5.2, §5.3).
 *
 * The invariants this file exists to hold:
 *   - the SERVER owns the clock. Every function takes `now` from the caller,
 *     which took it from `app.clock`; nothing here calls `new Date()` for a
 *     decision, and a deadline is only ever computed by
 *     `@quiz/domain#attemptDeadline` (invariant 5, §10);
 *   - a student payload is only ever produced by `./studentView.ts`
 *     (invariant 4);
 *   - creating an attempt is idempotent: `INSERT … ON CONFLICT DO NOTHING`
 *     on `(evaluation_id, user_id)`, so two tabs share one seed and one
 *     deadline;
 *   - autosave is ONE statement, never a read-modify-write: the conditional
 *     upsert of §4.7 settles the revision race in the database.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { and, asc, count, desc, eq, gte, inArray, isNotNull, lte, max, or, sql } from "drizzle-orm";

import {
  EvaluationSettings,
  GradingScale,
  type AttemptClosed,
  type AttemptInspect,
  type AttemptItem,
  type AttemptOrLobby,
  type AttemptState,
  type AttemptView,
  type AutosaveResponse,
  type CellStatus,
  type ClosedBy,
  type DashboardView,
  type EvaluationCard,
  type LobbyView,
  type RunnerResultEvent,
  type StudentHome,
  type Verdict,
} from "@quiz/contracts";
import {
  ANSWER_SUMMARY_MAX,
  isGraded,
  RunnerBusy,
  RunnerUnavailable,
  type AnyQuestionTypeServer,
  type FinalizeContext,
  type RunnerOutcome,
  type RunnerRequest,
  type RunnerService,
} from "@quiz/core/server";
import { shuffle, streamSeed } from "@quiz/core/rng";
import {
  GRACE_MS,
  attemptDeadline,
  bonusSeconds,
  gradeFromPoints,
  uniquePseudonyms,
} from "@quiz/domain";
import { caseVerdict } from "@quiz/qt-code/server";

import { iso, isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import {
  answers,
  attemptEvents,
  attempts,
  enrollments,
  evaluations,
  users,
} from "../../db/schema.js";
import { loadConfig, typeOf } from "../pool/config.js";
import {
  applyState,
  byId as evaluationById,
  feedbackOf,
  settingsOf,
  staffRosterWithAttempt,
  toEvaluation,
  tryApplyState,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import {
  gradeDefaults,
  joinedItem,
  joinedItems,
  studentEvaluationRows,
  totalPointsByEvaluation,
} from "../evaluation/service.js";
import * as events from "./events.js";
import { enqueueEvaluationGrading } from "../grading/jobs.js";
import {
  pairKey,
  pointsByAttempt,
  standingGradings,
  verdictOf,
  type GradingRecord,
  type PairKey,
} from "../grading/service.js";
import { presence } from "../realtime/presence.js";
import { UnavailableRunner } from "../runner/unavailable.js";
import { isShuffleable, solutionView, studentView } from "./studentView.js";

export type AttemptRecord = typeof attempts.$inferSelect;
type AnswerRecord = typeof answers.$inferSelect;

/** The teacher preview borrows a fixed attempt id: nothing is ever stored on it. */
export const PREVIEW_ATTEMPT_ID = "00000000-0000-4000-8000-000000000000";

// --- Failures -------------------------------------------------------------

export class LiveError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "LiveError";
  }
}

/** The 410 of §4.7. The body carries the reason AND the server's clock. */
export class AttemptClosedError extends LiveError {
  constructor(
    readonly reason: AttemptClosed["reason"],
    readonly deadlineAt: Date | null,
  ) {
    super("attempt_closed", 410, `attempt closed: ${reason}`);
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

class NotOpen extends LiveError {
  constructor() {
    super("not_open", 409, "this evaluation is not open");
  }
}
class AccessCodeInvalid extends LiveError {
  constructor() {
    super("access_code_invalid", 403);
  }
}
class IpNotAllowed extends LiveError {
  constructor() {
    super("ip_not_allowed", 403);
  }
}
export class AnswerInvalid extends LiveError {
  constructor(readonly details: unknown) {
    super("answer_invalid", 422);
  }
}
class Irreversible extends LiveError {
  constructor(message = "forward_only: marking a question done cannot be undone") {
    super("irreversible", 409, message);
  }
}
class ItemLocked extends LiveError {
  constructor(message = "navigation does not allow going back to this question") {
    super("item_locked", 409, message);
  }
}
export class RateLimited extends LiveError {
  constructor(readonly retryAfterS: number) {
    super("rate_limited", 429);
  }
}
export class RunnerDown extends LiveError {
  constructor(readonly reason: string) {
    super("runner_unavailable", 503, reason);
  }
}
class NotRunnable extends LiveError {
  constructor() {
    super("not_runnable", 422, "this question type has nothing to run");
  }
}
/**
 * The type CAN run, and this particular answer has nothing to run: an empty
 * schematic, a circuit with no stimulus. It is not `not_runnable` — that one
 * says the button should not be there at all — and it is not a 4xx the client
 * should report as an error, so the student's player says "draw something
 * first" rather than "the simulator is down".
 */
class NothingToRun extends LiveError {
  constructor() {
    super("nothing_to_run", 422, "this answer has nothing to run yet");
  }
}

// --- Deadlines ------------------------------------------------------------

interface DeadlineParts {
  deadlineAt: Date | null;
  bonusS: number;
}

/**
 * The ONE place an attempt deadline is computed (§10). `startedAt` is the
 * student's own start in `duration` timing, and is ignored in `deadline`
 * timing, where the base is the announced window (decision D8).
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
    timeBonusPercent: input.timeBonusPercent,
  };
  return {
    deadlineAt: attemptDeadline({ ...base, startedAt: input.startedAt, extraS: input.extraS }),
    bonusS: Math.round(bonusSeconds(base)),
  };
}

/** The acceptance rule, shared with the ticker through `GRACE_MS` (D12). */
function pastGrace(deadlineAt: Date | null, now: Date): boolean {
  return deadlineAt !== null && now.getTime() > deadlineAt.getTime() + GRACE_MS;
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
        eq(enrollments.classroomId, evaluation.classroomId),
        eq(enrollments.userId, userId),
        eq(enrollments.status, "claimed"),
      ),
    )
    .limit(1);
  return row ? { userId, guestId: null, timeBonusPercent: row.timeBonusPercent } : null;
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
        eq(enrollments.classroomId, evaluation.classroomId),
        eq(enrollments.userId, userId),
        eq(enrollments.status, "claimed"),
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
async function enrolledCounts(
  db: Db,
  rows: readonly EvaluationRecord[],
): Promise<Map<string, number>> {
  if (rows.length === 0) return new Map();
  const classroomIds = [...new Set(rows.map((r) => r.classroomId))];
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
      and(
        eq(attempts.userId, enrollments.userId),
        inArray(attempts.evaluationId, rows.map((r) => r.id)),
      ),
    )
    .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
    .where(and(eq(enrollments.classroomId, evaluations.classroomId), eq(enrollments.staff, true)))
    .groupBy(attempts.evaluationId);
  const byClassroom = new Map(klass.map((k) => [k.classroomId, k.n]));
  const byEvaluation = new Map(staff.map((s) => [s.evaluationId, s.n]));
  return new Map(
    rows.map((r) => [r.id, (byClassroom.get(r.classroomId) ?? 0) + (byEvaluation.get(r.id) ?? 0)]),
  );
}

/** F-EVAL-12: a prefix list, matched literally against the request address. */
function ipAllowed(allowlist: readonly string[], ip: string | undefined): boolean {
  if (allowlist.length === 0) return true;
  if (ip === undefined) return false;
  return allowlist.some((prefix) => ip.startsWith(prefix));
}

// --- Attempts -------------------------------------------------------------

export async function attemptById(db: Db, id: string): Promise<AttemptRecord | null> {
  const [row] = await db.select().from(attempts).where(eq(attempts.id, id)).limit(1);
  return row ?? null;
}

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
    .limit(1);
  return row ?? null;
}

/** A 32-bit seed, drawn once per attempt and never stored per permutation (D19). */
function drawSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/**
 * Idempotent creation. The unique index `(evaluation_id, user_id)` is the
 * mechanism: a second call inserts nothing and reads the row that is already
 * there, so two tabs opened at the same second share one seed, one start and
 * one deadline.
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
  const created = await db
    .insert(attempts)
    .values({
      id: randomUUID(),
      evaluationId: evaluation.id,
      ...ownerOf(participant),
      state: "not_started",
      seed: drawSeed(),
      presentAt: now,
      createdAt: now,
      updatedAt: now,
    })
    // A guest is keyed on `(evaluation_id, guest_id)`, an account on
    // `(evaluation_id, user_id)`: two unique indexes, the same idempotency.
    .onConflictDoNothing({
      target:
        participant.guestId === null
          ? [attempts.evaluationId, attempts.userId]
          : [attempts.evaluationId, attempts.guestId],
    })
    .returning({ id: attempts.id });
  const row = await attemptOf(db, evaluation.id, participant);
  if (!row) throw new LiveError("internal_error", 500, "attempt vanished after insert");
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
function orderItems(
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
 * `forward_only`: a question marked done is done. `milestones`: everything up
 * to and including the furthest milestone the student validated is closed.
 * Enforced HERE, on the server, and not only greyed out in the player.
 */
export function lockedItemIds(
  settings: EvaluationSettings,
  ordered: readonly OrderedItem[],
  answered: ReadonlyMap<string, AnswerRecord>,
): Set<string> {
  const locked = new Set<string>();
  if (settings.navigation === "free") return locked;
  if (settings.navigation === "forward_only") {
    for (const item of ordered) {
      if (answered.get(item.item.id)?.markedDone) locked.add(item.item.id);
    }
    return locked;
  }
  let furthest = -1;
  for (const item of ordered) {
    if (item.item.milestone && answered.get(item.item.id)?.markedDone) furthest = item.rank;
  }
  for (const item of ordered) if (item.rank <= furthest) locked.add(item.item.id);
  return locked;
}

async function answersOf(db: Db, attemptId: string): Promise<Map<string, AnswerRecord>> {
  const rows = await db.select().from(answers).where(eq(answers.attemptId, attemptId));
  return new Map(rows.map((r) => [r.itemId, r]));
}

// --- Views ----------------------------------------------------------------

function attemptItems(
  ordered: readonly OrderedItem[],
  answered: ReadonlyMap<string, AnswerRecord>,
  locked: ReadonlySet<string>,
  settings: EvaluationSettings,
  seed: number,
): AttemptItem[] {
  return ordered.map((entry) => {
    const answer = answered.get(entry.item.id) ?? null;
    const version = { config: entry.version.config, configVersion: entry.version.configVersion };
    return {
      id: entry.item.id,
      position: entry.item.position,
      points: entry.item.points,
      type: entry.question.type,
      milestone: entry.item.milestone,
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
      }),
      answer: answer?.payload ?? null,
      revision: answer?.revision ?? 0,
      markedDone: answer?.markedDone ?? false,
      locked: locked.has(entry.item.id),
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
function contentVisible(state: EvaluationRecord["state"]): boolean {
  return (
    state === "running" ||
    state === "paused" ||
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
): Promise<AttemptOrLobby> {
  if (!contentVisible(evaluation.state)) {
    const participant = await participantOfAttempt(db, evaluation, attempt);
    return { kind: "lobby", view: await lobbyView(db, evaluation, participant, now) };
  }
  return { kind: "attempt", view: await attemptView(db, evaluation, attempt, now) };
}

export async function attemptView(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
): Promise<AttemptView> {
  return viewOf(db, evaluation, {
    seed: attempt.seed,
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
 * The teacher's "see it as a student" (§4.3): a real student view, with seed
 * 0 so it is stable between reloads, and NO attempt row anywhere.
 */
export async function previewView(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<AttemptView> {
  return viewOf(db, evaluation, {
    seed: 0,
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
    answered: ReadonlyMap<string, AnswerRecord>;
    header: AttemptView["attempt"];
  },
): Promise<AttemptView> {
  const { seed, answered } = input;
  const settings = settingsOf(evaluation);
  const items = await joinedItems(db, evaluation.id);
  const ordered = orderItems(items, settings, seed, evaluation.id);
  const locked = lockedItemIds(settings, ordered, answered);
  return {
    attempt: input.header,
    evaluation: {
      id: evaluation.id,
      title: evaluation.title,
      mode: evaluation.mode,
      state: evaluation.state,
      settings,
      feedbackPolicy: feedbackOf(evaluation),
      pausedAt: isoOrNull(evaluation.pausedAt),
      totalPoints: Math.round(items.reduce((s, i) => s + i.item.points, 0) * 100) / 100,
    },
    items: attemptItems(ordered, answered, locked, settings, seed),
  };
}

export async function lobbyView(
  db: Db,
  evaluation: EvaluationRecord,
  participant: Participant,
  now: Date,
): Promise<LobbyView> {
  return {
    evaluation: {
      id: evaluation.id,
      title: evaluation.title,
      state: evaluation.state,
      announcedDurationS: evaluation.durationS,
    },
    present: presence.count(evaluation.id),
    enrolled: await enrolledCount(db, evaluation),
    timeBonusPercent: participant.timeBonusPercent,
    serverNow: iso(now),
  };
}

// --- Entering an evaluation ----------------------------------------------

type EnterResult =
  | { kind: "attempt"; view: AttemptView; attempt: AttemptRecord }
  | { kind: "lobby"; view: LobbyView; attempt: AttemptRecord };

/**
 * `POST /evaluations/:id/attempt` (F-LIVE-01). Idempotent end to end: the row,
 * the seed and the start instant are created at most once.
 */
export async function enterEvaluation(
  db: Db,
  input: {
    evaluation: EvaluationRecord;
    participant: Participant;
    accessCode?: string | undefined;
    ip?: string | undefined;
    now: Date;
  },
): Promise<EnterResult> {
  const { evaluation, participant, now } = input;
  if (evaluation.mode === "poll") throw new LiveError("not_implemented", 501, "poll is phase 2");
  if (evaluation.accessCode !== null && evaluation.accessCode !== input.accessCode) {
    throw new AccessCodeInvalid();
  }
  if (!ipAllowed(evaluation.ipAllowlist, input.ip)) throw new IpNotAllowed();

  const open = evaluation.state === "lobby" || evaluation.state === "running" ||
    evaluation.state === "paused";
  const existing = await attemptOf(db, evaluation.id, participant);
  // A closed evaluation still hands back a finished attempt: the student
  // must be able to reopen the page and see what they submitted.
  if (!open && existing === null) throw new NotOpen();

  let attempt = existing ?? (await ensureAttempt(db, evaluation, participant, now));
  await markPresent(db, attempt.id, now);

  if (evaluation.state === "running") {
    attempt = await beginAttempt(db, evaluation, attempt, participant, now);
  }
  const view = await attemptOrLobbyView(db, evaluation, attempt, now);
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
  return pastGrace(attempt.deadlineAt, now) ? "deadline" : null;
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
function assertWritable(
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

async function itemOf(
  db: Db,
  evaluationId: string,
  itemId: string,
): Promise<JoinedItem | null> {
  return joinedItem(db, evaluationId, itemId);
}

/** One line, and never wider than a cell (`ANSWER_SUMMARY_MAX`). */
function truncate(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= ANSWER_SUMMARY_MAX ? one : `${one.slice(0, ANSWER_SUMMARY_MAX - 1)}…`;
}

/**
 * The preview of a type that does not write its own — `qt-code` today, whose
 * answer is a set of editable regions: "12 L" is what a 64 px column can hold
 * and what a teacher reads across thirty rows, with the source itself one
 * click away in the inspect modal. Anything else falls back to its own short text form; the raw JSON
 * never reaches a cell.
 */
function genericSummary(payload: unknown): string {
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") return truncate(payload);
  if (typeof payload === "number" || typeof payload === "boolean") return String(payload);
  if (Array.isArray(payload)) return truncate(payload.map((v) => String(v)).join(" · "));
  const record = payload as Record<string, unknown>;
  const source = record["regions"] ?? record["source"] ?? record["files"];
  if (Array.isArray(source)) {
    const lines = source.reduce(
      (sum: number, part) => sum + (typeof part === "string" ? part.split("\n").length : 0),
      0,
    );
    return `${lines} L`;
  }
  if (typeof record["text"] === "string") return truncate(record["text"]);
  return "";
}

/**
 * A cell preview for the dashboard (F-DASH-02): what the student answered, in
 * a glyph or two.
 *
 * It used to be `JSON.stringify`, which put `{"text":"4"}` in the teacher's
 * column and made the "Answers" toggle worth nothing. The shape of an answer
 * belongs to the question type, so the type writes the preview:
 * `type.summarizeAnswer(config, answer)` (`@quiz/core`). This function is the
 * part that is NOT the type's — finding the type, parsing the stored payload
 * with the type's own `answerSchema`, and holding the result to the width of
 * a cell.
 *
 * Everything here is defensive on purpose: it runs on every autosave of every
 * student, and a preview is never worth a 500. A type with no hook (and a
 * payload the hook refused) falls back to {@link genericSummary}.
 *
 * It is a CLOSURE over one item because the dashboard summarises a whole
 * grid: the type and its configuration are resolved once per question and
 * reused down the column, instead of once per cell — twenty-four students
 * times ten questions is 240 config parses of ten distinct configs.
 */
function answerSummarizer(item: JoinedItem): (payload: unknown) => string {
  let hook: ((payload: unknown) => string) | null = null;
  try {
    const type = typeOf(item.question.type);
    const write = type.summarizeAnswer?.bind(type);
    if (write) {
      const config = loadConfig(item.question.type, {
        config: item.version.config,
        configVersion: item.version.configVersion,
      });
      hook = (payload) => {
        const answer = type.answerSchema.safeParse(payload);
        return answer.success ? truncate(write(config, answer.data)) : genericSummary(payload);
      };
    }
  } catch {
    /* an unknown type or an unreadable config: the generic form still says something */
  }
  const write = hook;
  return (payload) => {
    if (payload === null || payload === undefined) return "";
    try {
      return write ? write(payload) : genericSummary(payload);
    } catch {
      return genericSummary(payload);
    }
  };
}

/** {@link answerSummarizer} for one cell. */
export function summarizeAnswer(item: JoinedItem, payload: unknown): string {
  return answerSummarizer(item)(payload);
}

/**
 * ADR-020 — the verdict a cell WOULD get if the evaluation closed now.
 *
 * The "Results" toggle of the live dashboard used to mean "show the gradings
 * there are", and before closing there are none: the teacher watched a wall
 * of blue "done" cells and a class row reading "after closing", on the one
 * screen whose job is to say whether the class has understood. So the server
 * grades the answer it already holds, with the type's OWN `grade` — the same
 * function the grading pass calls, on the same config, so a preview and the
 * final grading can never disagree by construction.
 *
 * Four properties make that safe rather than clever:
 *   - it is READ-ONLY. Nothing is written to `gradings`, nothing is queued,
 *     no job is enqueued, and the grading pass at closing runs exactly as it
 *     did. A preview is a number computed and thrown away;
 *   - it never reaches a student. It travels on `DashboardView` and on the
 *     staff-only `dashboard.cell` frame, neither of which goes through
 *     `toStudent`, and the student payloads are untouched (invariant 4);
 *   - it is only ever asked for by the teacher who turned the toggle on
 *     (`?results=1`), so a projected grid costs nothing when the switch is
 *     off;
 *   - a type that needs the RUNNER gets no preview. `finalizeRunner` is the
 *     declaration of "graded in two halves"; building the request and running
 *     nothing would cost the assembly of every source file of every student
 *     on every refresh, to answer `null`. `code` and `circuit` therefore
 *     colour when their real grading lands, exactly as before.
 *
 * Returns `null` for a question this cannot preview, which the caller reads
 * as "no live verdict for this column".
 */
function liveGrader(
  item: JoinedItem,
  evaluation: EvaluationRecord,
  now: Date,
): ((attempt: AttemptRecord, payload: unknown) => Promise<GradedCell | null>) | null {
  let type: AnyQuestionTypeServer;
  let config: unknown;
  try {
    type = typeOf(item.question.type);
    if (type.finalizeRunner) return null;
    config = loadConfig(item.question.type, {
      config: item.version.config,
      configVersion: item.version.configVersion,
    });
  } catch {
    // An unknown type or a config this build cannot read: no preview, and
    // certainly not a 500 on the teacher's dashboard.
    return null;
  }
  const runner = new UnavailableRunner("live_preview");
  const defaults = gradeDefaults(evaluation);
  return async (attempt, payload) => {
    try {
      const parsed = type.answerSchema.safeParse(payload);
      if (!parsed.success) return null;
      const result = await type.grade(config, parsed.data, {
        seed: attempt.seed,
        itemId: item.item.id,
        attemptId: attempt.id,
        itemPoints: item.item.points,
        now,
        runner,
        defaults,
      });
      if (!isGraded(result)) return null;
      const points = Math.round(result.points * 100) / 100;
      const maxPoints = result.maxPoints;
      return {
        verdict: verdictOf({ points, maxPoints, state: "validated" }),
        rate: maxPoints > 0 ? points / maxPoints : null,
      };
    } catch {
      // A grader that throws on a half-typed answer is expected while the
      // student is still typing; the cell simply keeps its progress colour.
      return null;
    }
  };
}

/** What {@link liveGrader} answers: a colour, and the share it counts for. */
interface GradedCell {
  verdict: Verdict;
  rate: number | null;
}

/** {@link liveGrader} for ONE cell, which is what an autosave moves. */
async function previewVerdict(
  evaluation: EvaluationRecord,
  item: JoinedItem,
  attempt: AttemptRecord,
  payload: unknown,
  now: Date,
): Promise<Verdict | null> {
  if (payload === null || payload === undefined) return null;
  const grade = liveGrader(item, evaluation, now);
  if (!grade) return null;
  return (await grade(attempt, payload))?.verdict ?? null;
}

function cellStatus(answer: AnswerRecord | null): CellStatus {
  if (!answer) return "empty";
  if (answer.markedDone) return "done";
  return answer.revision > 0 ? "in_progress" : "seen";
}

/**
 * ONE statement, no read-modify-write (§4.7). `WHERE answers.revision <
 * excluded.revision` is what makes two concurrent writes deterministic: the
 * higher revision wins, and the loser is told which payload to adopt.
 */
export async function saveAnswer(
  db: Db,
  input: {
    evaluation: EvaluationRecord;
    attempt: AttemptRecord;
    itemId: string;
    payload: unknown;
    revision: number;
    now: Date;
  },
): Promise<AutosaveResponse> {
  const { evaluation, attempt, itemId, revision, now } = input;
  assertWritable(evaluation, attempt, now);

  // Free navigation needs this one item only. A locking mode needs the whole
  // ordered list anyway, so the item is taken from it rather than read twice.
  const settings = settingsOf(evaluation);
  const ordered =
    settings.navigation === "free"
      ? null
      : orderItems(await joinedItems(db, evaluation.id), settings, attempt.seed, evaluation.id);
  const joined = ordered
    ? (ordered.find((o) => o.item.id === itemId) ?? null)
    : await itemOf(db, evaluation.id, itemId);
  if (!joined) throw new LiveError("not_found", 404);

  const stored = await answersOf(db, attempt.id);
  if (ordered && lockedItemIds(settings, ordered, stored).has(itemId)) throw new ItemLocked();

  // Never persist garbage: the type's own schema is the gate (§4.7 step 6).
  const type = typeOf(joined.question.type);
  const parsed = type.answerSchema.safeParse(input.payload);
  if (!parsed.success) throw new AnswerInvalid(parsed.error.issues);
  const payload = parsed.data;

  const written = await db
    .insert(answers)
    .values({
      id: randomUUID(),
      attemptId: attempt.id,
      itemId,
      payload,
      revision,
      firstSeenAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [answers.attemptId, answers.itemId],
      set: {
        payload: sql`excluded.payload`,
        revision: sql`excluded.revision`,
        updatedAt: now,
      },
      setWhere: sql`${answers.revision} < excluded.revision`,
    })
    .returning({ payload: answers.payload, revision: answers.revision });

  if (written.length === 0) {
    // Stale: the row in the database is newer. Hand it back so the client
    // adopts it (last-writer-wins by revision).
    const current = stored.get(itemId);
    return {
      accepted: false,
      revision: current?.revision ?? 0,
      payload: current?.payload ?? null,
      serverNow: iso(now),
    };
  }

  const row = written[0]!;
  events.cellChanged({
    evaluationId: evaluation.id,
    attemptId: attempt.id,
    itemId,
    status: stored.get(itemId)?.markedDone === true ? "done" : "in_progress",
    revision: row.revision,
    summary: summarizeAnswer(joined, row.payload),
    verdict: await previewVerdict(evaluation, joined, attempt, row.payload, now),
  });
  return { accepted: true, revision: row.revision, serverNow: iso(now) };
}

/** F-LIVE-08. In `forward_only` the flag only ever goes up. */
export async function markDone(
  db: Db,
  input: {
    evaluation: EvaluationRecord;
    attempt: AttemptRecord;
    itemId: string;
    done: boolean;
    now: Date;
  },
): Promise<{ done: boolean; nextItemId: string | null }> {
  const { evaluation, attempt, itemId, now } = input;
  assertWritable(evaluation, attempt, now);
  const settings = settingsOf(evaluation);
  const stored = await answersOf(db, attempt.id);
  const current = stored.get(itemId) ?? null;
  if (settings.navigation === "forward_only" && current?.markedDone && !input.done) {
    throw new Irreversible();
  }

  if (current) {
    await db
      .update(answers)
      .set({ markedDone: input.done, updatedAt: now })
      .where(eq(answers.id, current.id));
  } else {
    // "Seen, nothing typed": the row has to exist for the flag to, and
    // `payload` is NOT NULL, so it holds the JSON value `null` — which is
    // what a type's `grade(config, null, …)` already means (F-GRADE-01).
    await db.insert(answers).values({
      id: randomUUID(),
      attemptId: attempt.id,
      itemId,
      payload: sql`'null'::jsonb`,
      revision: 0,
      markedDone: input.done,
      firstSeenAt: now,
      updatedAt: now,
    });
  }

  const ordered = orderItems(
    await joinedItems(db, evaluation.id),
    settings,
    attempt.seed,
    evaluation.id,
  );
  const ownItem = ordered.find((o) => o.item.id === itemId) ?? null;
  const rank = ownItem?.rank ?? -1;
  const next = ordered.find((o) => o.rank === rank + 1)?.item.id ?? null;
  if (next !== null) await db.update(attempts).set({ lastItemId: next, updatedAt: now }).where(eq(attempts.id, attempt.id));

  events.cellChanged({
    evaluationId: evaluation.id,
    attemptId: attempt.id,
    itemId,
    status: input.done ? "done" : cellStatus(current),
    revision: current?.revision ?? 0,
    summary: current && ownItem ? summarizeAnswer(ownItem, current.payload) : null,
    verdict:
      current && ownItem
        ? await previewVerdict(evaluation, ownItem, attempt, current.payload, now)
        : null,
  });
  return { done: input.done, nextItemId: next };
}

/** F-LIVE-06: where the student was, so a reload lands on the same question. */
export async function setPosition(
  db: Db,
  attempt: AttemptRecord,
  itemId: string,
  now: Date,
): Promise<void> {
  await db
    .update(attempts)
    .set({ lastItemId: itemId, presentAt: now, updatedAt: now })
    .where(eq(attempts.id, attempt.id));
}

/** F-LIVE-10. Terminal and irreversible for the student. */
export async function submitAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
): Promise<AttemptRecord> {
  assertGate(evaluation, attempt, now, "submit");
  await db
    .update(attempts)
    .set({
      state: "submitted",
      submittedAt: now,
      closedAt: now,
      closedBy: "student",
      updatedAt: now,
    })
    .where(and(eq(attempts.id, attempt.id), eq(attempts.state, "in_progress")));
  const row = (await attemptById(db, attempt.id))!;
  events.attemptClosed(evaluation.id, row, "student", now);
  return row;
}

/** F-EVAL-13. Journalled, never blocking. */
export async function logAttemptEvent(
  db: Db,
  attemptId: string,
  kind: typeof attemptEvents.$inferInsert["kind"],
  details: unknown,
  now: Date,
): Promise<void> {
  await db.insert(attemptEvents).values({
    id: randomUUID(),
    attemptId,
    kind,
    at: now,
    details: details ?? null,
  });
}

/** Rate limit of a journalled kind, counted in the database (no extra table). */
export async function countRecentEvents(
  db: Db,
  attemptId: string,
  kind: typeof attemptEvents.$inferInsert["kind"],
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(attemptEvents)
    .where(
      and(
        eq(attemptEvents.attemptId, attemptId),
        eq(attemptEvents.kind, kind),
        gte(attemptEvents.at, since),
      ),
    );
  return row?.n ?? 0;
}

// --- Running code (F-QST-09 for the student side) -------------------------

/** What `type.toStudent` exposes about running; read structurally, never cast. */
interface RunnableStudentView {
  runsPerMinute?: number;
  /** The same budget under the name the `circuit` type gives it (ADR-019). */
  simulationsPerMinute?: number;
  visibleCases?: {
    name: string;
    stdin: string;
    expected: string;
    compareStdout: boolean;
    expectedExitCode: number | null;
  }[];
  /** How a visible case's output is compared: the grade's own options (R-06). */
  compare?: CaseCompare;
}

type CaseCompare = NonNullable<Parameters<typeof caseVerdict>[2]>;

/** The comparison options of a student view, read field by field. */
function compareOf(raw: unknown): CaseCompare | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  const out: CaseCompare = {};
  if (typeof c["trimTrailing"] === "boolean") out.trimTrailing = c["trimTrailing"];
  if (typeof c["ignoreCase"] === "boolean") out.ignoreCase = c["ignoreCase"];
  const numeric = c["numeric"];
  if (numeric === null) out.numeric = null;
  else if (typeof numeric === "object") {
    const { epsilon, mode } = numeric as Record<string, unknown>;
    if (typeof epsilon === "number" && (mode === "abs" || mode === "rel")) {
      out.numeric = { epsilon, mode };
    }
  }
  return out;
}

function runnableView(student: unknown): RunnableStudentView {
  if (student === null || typeof student !== "object") return {};
  const source = student as Record<string, unknown>;
  const out: RunnableStudentView = {};
  if (typeof source["runsPerMinute"] === "number") out.runsPerMinute = source["runsPerMinute"];
  if (typeof source["simulationsPerMinute"] === "number") {
    out.simulationsPerMinute = source["simulationsPerMinute"];
  }
  if (Array.isArray(source["visibleCases"])) {
    out.visibleCases = source["visibleCases"].flatMap((raw) => {
      if (raw === null || typeof raw !== "object") return [];
      const c = raw as Record<string, unknown>;
      // The two checks default the way the schema defaults them, so a type
      // that says nothing about them still means "compare stdout, want 0".
      return typeof c["name"] === "string"
        ? [
            {
              name: c["name"],
              stdin: typeof c["stdin"] === "string" ? c["stdin"] : "",
              expected: typeof c["expected"] === "string" ? c["expected"] : "",
              compareStdout: c["compareStdout"] !== false,
              expectedExitCode:
                c["expectedExitCode"] === null
                  ? null
                  : typeof c["expectedExitCode"] === "number"
                    ? c["expectedExitCode"]
                    : 0,
            },
          ]
        : [];
    });
  }
  const compare = compareOf(source["compare"]);
  if (compare !== undefined) out.compare = compare;
  return out;
}

const DEFAULT_RUNS_PER_MINUTE = 10;

/** The only check a free stdin try can make: the program exits 0. */
const FREE_TRY = { expected: "", compareStdout: false, expectedExitCode: 0 };

/**
 * The common gate of `POST /attempts/:id/run` and `/simulate`, in this order:
 * the attempt is writable (invariant 5), the item belongs to the evaluation,
 * the type has the capability the button needs, the journal-counted budget
 * is not spent (N-SEC-07), the answer parses under the type's own schema
 * (invariant 7), and the stored config loads.
 */
async function attemptRunContext<T>(
  db: Db,
  input: {
    evaluation: EvaluationRecord;
    attempt: AttemptRecord;
    itemId: string;
    now: Date;
    /** The hook the button runs through; `undefined` is `not_runnable`. */
    capability: (type: AnyQuestionTypeServer) => T | undefined;
    /** The per-minute budget the type publishes in its student view. */
    budget: (student: RunnableStudentView) => number | undefined;
    answer: unknown;
  },
) {
  const { evaluation, attempt, itemId, now } = input;
  // The server owns the clock: a run is a write's worth of work, so it is
  // refused past the deadline exactly like an autosave (invariant 5).
  assertWritable(evaluation, attempt, now);
  const joined = await itemOf(db, evaluation.id, itemId);
  // 404 and not 403: an item of another evaluation is indistinguishable from
  // one that does not exist (invariant 6).
  if (!joined) throw new LiveError("not_found", 404);

  const type = typeOf(joined.question.type);
  const capability = input.capability(type);
  if (capability === undefined) throw new NotRunnable();

  const version = { config: joined.version.config, configVersion: joined.version.configVersion };
  const student = runnableView(
    studentView({ type: joined.question.type, version, seed: attempt.seed, itemId, shuffle: false }),
  );

  // N-SEC-07: the budget is the question's own, counted from the journal
  // rather than from a table of its own. Both buttons count `run` events, so
  // a student cannot double their budget by using both on one attempt.
  const limit = input.budget(student) ?? DEFAULT_RUNS_PER_MINUTE;
  const used = await countRecentEvents(db, attempt.id, "run", new Date(now.getTime() - 60_000));
  if (used >= limit) throw new RateLimited(60);

  const answer = type.answerSchema.safeParse(input.answer);
  if (!answer.success) throw new AnswerInvalid(answer.error.issues);

  const config: unknown = loadConfig(joined.question.type, version);
  const ctx: FinalizeContext = {
    seed: attempt.seed,
    itemId,
    attemptId: attempt.id,
    itemPoints: joined.item.points,
    now,
    // Same per-type settings as the grading pass: what the student tries
    // must not be scored under a different policy than the final grading.
    defaults: gradeDefaults(evaluation),
  };
  return { type, capability, student, config, answer: answer.data as unknown, ctx };
}

/**
 * Journals a student's run (nothing student-supplied: the file names are the
 * type's, invariant 14), then runs it; a busy or absent runner is the 503.
 */
async function runForStudent(
  db: Db,
  input: { runner: RunnerService; attempt: AttemptRecord; request: RunnerRequest; now: Date },
  details: Record<string, unknown>,
): Promise<{ requestId: string; outcome: RunnerOutcome }> {
  const requestId = randomUUID();
  await logAttemptEvent(db, input.attempt.id, "run", { ...details, requestId }, input.now);
  try {
    return { requestId, outcome: await input.runner.run(input.request) };
  } catch (error) {
    if (error instanceof RunnerBusy) throw new RunnerDown("busy");
    if (error instanceof RunnerUnavailable) throw new RunnerDown(error.reason);
    throw error;
  }
}

/**
 * `POST /attempts/:id/run` — the student's Run button.
 *
 * Only the VISIBLE cases are sent (or the student's own stdin), the source is
 * rebuilt server-side from the template and the editable regions (invariant
 * 14), and the outcome is published as `runner.result` on the student's own
 * topic. With `RUNNER_MODE=stub` — the default everywhere until a machine
 * with Podman exists (decision D14) — this ends in `503 runner_unavailable`,
 * which is a configuration, not a failure.
 */
export async function runVisibleCases(
  db: Db,
  input: {
    runner: RunnerService;
    evaluation: EvaluationRecord;
    attempt: AttemptRecord;
    itemId: string;
    regions: string[];
    stdin?: string | undefined;
    /** The command line of the free-stdin try; a visible case keeps the teacher's. */
    args?: string[] | undefined;
    now: Date;
  },
): Promise<{ requestId: string; result: RunnerResultEvent["result"] }> {
  const { attempt, itemId } = input;
  const prepared = await attemptRunContext(db, {
    ...input,
    // A type with no second half has nothing a runner could finish.
    capability: (type) => type.finalizeRunner,
    budget: (student) => student.runsPerMinute,
    answer: { regions: input.regions },
  });
  const { type, config, answer, ctx } = prepared;
  const first = await type.grade(config, answer, { ...ctx, runner: input.runner });
  // `grade` assembles the request server-side from the template and the
  // regions (invariant 14); nothing the browser sent becomes a file name.
  if (first.kind !== "pending" || first.via !== "runner") throw new NotRunnable();

  const visible = prepared.student.visibleCases ?? [];
  const visibleNames = new Set(visible.map((c) => c.name));
  const specOf = new Map(visible.map((c) => [c.name, c]));
  // Only what the student may already see: their own stdin, or the VISIBLE
  // cases. The hidden half never leaves the grading worker. A visible case
  // keeps the `args` the TYPE put in the request (invariant 14); only the
  // free-stdin try takes a command line from the browser.
  const cases =
    input.stdin === undefined
      ? first.request.cases.filter((c) => visibleNames.has(c.name))
      : [{ name: "stdin", args: input.args ?? [], stdin: input.stdin }];
  const request = { ...first.request, cases, priority: "interactive" as const };

  const { requestId, outcome } = await runForStudent(db, { ...input, request }, { itemId });
  const result: RunnerResultEvent["result"] = {
    status: "ok",
    compile: { ok: outcome.compile.ok, stderr: outcome.compile.stderr },
    cases: cases.map((c, index) => {
      const run = outcome.cases[index];
      const spec = specOf.get(c.name);
      // Nothing to compare when the case does not compare stdout, and
      // nothing to show either.
      const expected = spec === undefined || !spec.compareStdout ? "" : spec.expected;
      // The grade's own rule, with the teacher's comparison options, so the
      // player's verdict and the grade cannot disagree (ADR-015, audit R-06).
      // A free stdin try has no case behind it: exit 0 is all it can mean.
      const verdict = caseVerdict(spec ?? FREE_TRY, run, prepared.student.compare);
      return {
        name: c.name,
        ok: verdict.ok,
        // The facts the player names the failure by ("exit 1 ≠ 0", "Output
        // differs", "Timed out"): the same fields a browser run reports.
        exitCode: run?.exitCode ?? null,
        stdout: run?.stdout ?? "",
        stderr: run?.stderr ?? "",
        expected,
        ms: run?.ms ?? 0,
        timedOut: run?.timedOut ?? false,
        oom: run?.oom ?? false,
        truncated: run?.truncated ?? false,
      };
    }),
  };

  // The result travels on the student's own topic (§4.8) AND in the response,
  // so a client that lost its stream is not left waiting.
  // `POST /attempts/:id/run` is reached through `ownAttempt`, so the owner
  // is always an account here; a poll runs no code.
  if (attempt.userId !== null) events.runnerResult(attempt.userId, requestId, itemId, result);
  return { requestId, result };
}

/**
 * `POST /attempts/:id/simulate` — the student's own button, for a type that
 * builds its OWN request (ADR-019).
 *
 * The generic half of `runVisibleCases`: same gate, same budget, same
 * journal, but the request comes from `type.interactiveRequest` instead of
 * from the first half of a grading. The type assembles it server-side from
 * the STORED config and the parsed answer (invariant 14) and puts in it only
 * what the student may already see — a `circuit` sends the visible stimuli
 * and never the reference's waveform. Nothing here inspects the request: the
 * live module does not know what a netlist is.
 *
 * The outcome comes back raw, in the response and nowhere else. A `code` run
 * needs an SSE frame because its result is a verdict the dashboard also
 * cares about; a simulation is a curve the student asked for, so the response
 * is the delivery.
 */
export async function simulateAnswer(
  db: Db,
  input: {
    runner: RunnerService;
    evaluation: EvaluationRecord;
    attempt: AttemptRecord;
    itemId: string;
    answer: unknown;
    now: Date;
  },
): Promise<RunnerOutcome> {
  const prepared = await attemptRunContext(db, {
    ...input,
    // A type with no button of its own. `code` is not one of them: it keeps
    // its older, case-filtering `/run` route.
    capability: (type) => type.interactiveRequest?.bind(type),
    // The same budget as `/run`, under whichever name the type publishes it:
    // a circuit says `simulationsPerMinute`, a code question `runsPerMinute`.
    budget: (student) => student.simulationsPerMinute ?? student.runsPerMinute,
    // Invariant 7's second half: the envelope was parsed by `SimulateBody`,
    // the payload is parsed by the schema the type and the client share.
    answer: input.answer,
  });
  const built = prepared.capability(prepared.config, prepared.answer, prepared.ctx);
  if (built === null) throw new NothingToRun();

  // `kind: "simulate"` tells the two buttons apart in the journal; the EVENT
  // stays a `run`, because the budget is one and the audit union is closed
  // (invariant 9).
  const request: RunnerRequest = { ...built, priority: "interactive" };
  const { outcome } = await runForStudent(db, { ...input, request }, {
    itemId: input.itemId,
    kind: "simulate",
  });
  return outcome;
}

// --- Teacher controls (§5.1, F-LIVE-11) -----------------------------------

interface AttemptWithBonus extends AttemptRecord {
  timeBonusPercent: number;
}

async function attemptsWithBonus(db: Db, evaluation: EvaluationRecord): Promise<AttemptWithBonus[]> {
  const rows = await db
    .select({ attempt: attempts, bonus: enrollments.timeBonusPercent })
    .from(attempts)
    .leftJoin(
      enrollments,
      and(
        eq(enrollments.userId, attempts.userId),
        eq(enrollments.classroomId, evaluation.classroomId),
      ),
    )
    .where(eq(attempts.evaluationId, evaluation.id));
  return rows.map((r) => ({ ...r.attempt, timeBonusPercent: r.bonus ?? 0 }));
}

/** `lobby|scheduled|draft → running` (F-LIVE-03/04). */
export async function startEvaluation(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<EvaluationRecord> {
  const next = await applyState(db, evaluation, "running", now);
  for (const attempt of await attemptsWithBonus(db, next)) {
    if (attempt.state !== "not_started") continue;
    await beginAttempt(
      db,
      next,
      attempt,
      {
        userId: attempt.userId,
        guestId: attempt.guestId,
        timeBonusPercent: attempt.timeBonusPercent,
      },
      now,
    );
  }
  events.stateChanged(next, now);
  return next;
}

/** `running → paused` (F-LIVE-11). Writes 410 with reason `paused` (D17). */
export async function pauseEvaluation(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<EvaluationRecord> {
  const next = await applyState(db, evaluation, "paused", now);
  for (const attempt of await attemptsWithBonus(db, next)) {
    if (attempt.state === "in_progress") await logAttemptEvent(db, attempt.id, "paused", null, now);
  }
  events.stateChanged(next, now);
  return next;
}

/**
 * `paused → running`: every in-progress deadline moves forward by exactly the
 * time the evaluation stood still, so a pause never costs a student a second.
 */
export async function resumeEvaluation(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<EvaluationRecord> {
  const pausedFor = evaluation.pausedAt === null ? 0 : now.getTime() - evaluation.pausedAt.getTime();
  // Compare-and-set: a double-clicked resume (or a second ticker process)
  // must not add the pause to every deadline twice.
  const next = await tryApplyState(db, evaluation, "running", now);
  if (next === null) return (await evaluationById(db, evaluation.id))!;
  if (pausedFor > 0) {
    await db
      .update(attempts)
      .set({
        deadlineAt: sql`${attempts.deadlineAt} + make_interval(secs => ${pausedFor / 1000})`,
        extraS: sql`${attempts.extraS} + ${Math.round(pausedFor / 1000)}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(attempts.evaluationId, next.id),
          eq(attempts.state, "in_progress"),
          isNotNull(attempts.deadlineAt),
        ),
      );
  }
  for (const attempt of await attemptsWithBonus(db, next)) {
    if (attempt.state !== "in_progress") continue;
    await logAttemptEvent(db, attempt.id, "resumed", { pausedMs: pausedFor }, now);
    events.deadlineChanged(next, attempt, "pause_resume", now);
  }
  events.stateChanged(next, now);
  return next;
}

/**
 * `* → closed`: every open attempt becomes `expired`, closed by the teacher.
 *
 * Closing is also what starts the automatic correction (§5.4): when the
 * caller hands over the Fastify instance — the route and the ticker both do —
 * the `grading.evaluation` singleton is enqueued here, so the two entry
 * points cannot drift apart. A caller that passes nothing (a unit test on the
 * transition alone) closes without grading.
 */
export async function closeEvaluation(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
  closedBy: ClosedBy = "teacher",
  app?: FastifyInstance,
): Promise<EvaluationRecord> {
  const open = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.evaluationId, evaluation.id), eq(attempts.state, "in_progress")));
  await db
    .update(attempts)
    .set({ state: "expired", closedAt: now, closedBy, updatedAt: now })
    .where(and(eq(attempts.evaluationId, evaluation.id), eq(attempts.state, "in_progress")));
  const next = await applyState(db, evaluation, "closed", now);
  for (const attempt of open) events.attemptClosed(next.id, attempt, closedBy, now);
  events.stateChanged(next, now);
  if (app) await enqueueEvaluationGrading(app, { evaluationId: next.id });
  return next;
}

/** F-LIVE-11/12: +1, +5 or +10 minutes, to everybody or to one student. */
export async function extendTime(
  db: Db,
  evaluation: EvaluationRecord,
  input: { minutes: number; attemptId?: string | undefined },
  now: Date,
): Promise<number> {
  const seconds = input.minutes * 60;
  const target = input.attemptId;
  // In `deadline` timing the attempts hang off `closes_at` (§5.2): extending
  // everybody without moving it would hand the minutes out and let the
  // ticker take them back at the old instant.
  if (target === undefined && settingsOf(evaluation).timing === "deadline" && evaluation.closesAt) {
    const closesAt = new Date(evaluation.closesAt.getTime() + seconds * 1000);
    await db
      .update(evaluations)
      .set({ closesAt, updatedAt: now })
      .where(eq(evaluations.id, evaluation.id));
    // The dashboard and the players read the new end from this frame.
    events.stateChanged({ ...evaluation, closesAt }, now);
  }
  const where =
    target === undefined
      ? and(eq(attempts.evaluationId, evaluation.id), inArray(attempts.state, ["not_started", "in_progress"]))
      : and(eq(attempts.id, target), eq(attempts.evaluationId, evaluation.id));
  const updated = await db
    .update(attempts)
    .set({
      extraS: sql`${attempts.extraS} + ${seconds}`,
      // A `manual` attempt has no deadline to move; the extra time is still
      // recorded, so a later switch of timing mode is consistent.
      deadlineAt: sql`case when ${attempts.deadlineAt} is null then null else ${attempts.deadlineAt} + make_interval(secs => ${seconds}) end`,
      updatedAt: now,
    })
    .where(where)
    .returning({ id: attempts.id });
  for (const row of updated) {
    const attempt = (await attemptById(db, row.id))!;
    await logAttemptEvent(db, row.id, "time_added", { minutes: input.minutes }, now);
    events.deadlineChanged(evaluation, attempt, "teacher_extend", now);
  }
  return updated.length;
}

/** Closes ONE attempt without closing the evaluation (F-LIVE-11). */
export async function closeAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
): Promise<AttemptRecord> {
  await db
    .update(attempts)
    .set({ state: "expired", closedAt: now, closedBy: "teacher", updatedAt: now })
    .where(and(eq(attempts.id, attempt.id), eq(attempts.state, "in_progress")));
  const row = (await attemptById(db, attempt.id))!;
  events.attemptClosed(evaluation.id, row, "teacher", now);
  return row;
}

/**
 * Reopens one attempt (a student closed a tab too early, a laptop died). The
 * deadline is recomputed from the ORIGINAL start plus everything already
 * granted, so reopening is not a second full duration.
 */
export async function reopenAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
): Promise<AttemptRecord> {
  if (attempt.state === "in_progress") return attempt;
  const participant = await participantOfAttempt(db, evaluation, attempt);
  const { deadlineAt, bonusS } = deadlineFor(evaluation, {
    startedAt: attempt.startedAt ?? now,
    timeBonusPercent: participant.timeBonusPercent,
    extraS: attempt.extraS,
  });
  await db
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
  const row = (await attemptById(db, attempt.id))!;
  events.deadlineChanged(evaluation, row, "reopen", now);
  return row;
}

// --- Dashboard read model (F-DASH-01..04) ---------------------------------

export async function dashboardView(
  db: Db,
  evaluation: EvaluationRecord,
  input: { now: Date; includeAnswers: boolean; includeResults: boolean },
): Promise<DashboardView> {
  const items = await joinedItems(db, evaluation.id);
  const roster = await db
    .select({
      userId: enrollments.userId,
      nom: enrollments.nom,
      prenom: enrollments.prenom,
      email: enrollments.email,
      timeBonusPercent: enrollments.timeBonusPercent,
    })
    .from(enrollments)
    .where(
      and(eq(enrollments.classroomId, evaluation.classroomId), eq(enrollments.staff, false)),
    )
    .orderBy(asc(enrollments.nom), asc(enrollments.prenom));
  /*
   * The teacher's own test walk, under the class and never among it
   * (ADR-018). It is here because a teacher who is testing wants to watch
   * their own row light up like anybody else's; it is LAST and flagged
   * because everything this grid totals is about the class.
   */
  const staffRoster = await staffRosterWithAttempt(db, evaluation);
  const seats = [
    ...roster.map((entry) => ({ ...entry, staff: false })),
    ...staffRoster.map((entry) => ({ ...entry, staff: true })),
  ];

  const attemptRows = await db
    .select()
    .from(attempts)
    .where(eq(attempts.evaluationId, evaluation.id));
  const byUser = new Map(attemptRows.map((a) => [a.userId, a]));

  const answerRows =
    attemptRows.length === 0
      ? []
      : await db
          .select()
          .from(answers)
          .where(inArray(answers.attemptId, attemptRows.map((a) => a.id)));
  const byAttempt = new Map<string, Map<string, AnswerRecord>>();
  for (const row of answerRows) {
    let map = byAttempt.get(row.attemptId);
    if (!map) {
      map = new Map();
      byAttempt.set(row.attemptId, map);
    }
    map.set(row.itemId, row);
  }

  // The grades of the grid (F-DASH-01): every grading still standing, in one
  // query. A proposal shows as `pending`, a validated one as its verdict.
  const standing: ReadonlyMap<PairKey, GradingRecord> = await standingGradings(db, evaluation.id);

  const userIds = roster.map((r) => r.userId).filter((id): id is string => id !== null);
  const pseudonyms = uniquePseudonyms(evaluation.id, userIds);
  const online = presence.online(evaluation.id);
  const maxPoints = Math.round(items.reduce((s, i) => s + i.item.points, 0) * 100) / 100;

  // One summarizer per QUESTION (see `answerSummarizer`), built only when the
  // teacher actually asked for the answers.
  const summarize = new Map<string, (payload: unknown) => string>(
    input.includeAnswers ? items.map((item) => [item.item.id, answerSummarizer(item)]) : [],
  );

  /*
   * One live grader per QUESTION (ADR-020), built only when the teacher asked
   * for the results — the type and its configuration are parsed once per
   * column and reused down it, exactly like the summarizer above. A column
   * whose type is graded by the runner has no entry at all, so its cells cost
   * nothing.
   */
  const preview = new Map<string, NonNullable<ReturnType<typeof liveGrader>>>();
  if (input.includeResults) {
    for (const item of items) {
      const grader = liveGrader(item, evaluation, input.now);
      if (grader) preview.set(item.item.id, grader);
    }
  }
  /** The live rate of each item, over the CLASS rows only (ADR-018). */
  const liveRates = new Map<string, number[]>();

  const rows: DashboardView["rows"] = await Promise.all(
    seats
    .filter((r) => r.userId !== null)
    .map(async (entry) => {
      const userId = entry.userId!;
      const attempt = byUser.get(userId) ?? null;
      const answered = attempt ? (byAttempt.get(attempt.id) ?? new Map()) : new Map();
      return {
        attemptId: attempt?.id ?? null,
        userId,
        staff: entry.staff,
        displayName: `${entry.prenom} ${entry.nom}`.trim() || entry.email,
        pseudonym: pseudonyms.get(userId) ?? "—",
        state: (attempt?.state ?? "not_started") as AttemptState,
        online: online.has(userId),
        lastSeenAt: isoOrNull(presence.lastSeenAt(evaluation.id, userId) ?? attempt?.presentAt ?? null),
        deadlineAt: isoOrNull(attempt?.deadlineAt ?? null),
        timeBonusPercent: entry.timeBonusPercent,
        points: attempt ? pointsOf(standing, attempt.id, items) : null,
        maxPoints,
        cells: await Promise.all(
          items.map(async (item) => {
            const answer: AnswerRecord | null = answered.get(item.item.id) ?? null;
            const grading = attempt
              ? (standing.get(pairKey(attempt.id, item.item.id)) ?? null)
              : null;
            // A grading on record always wins: a preview never overwrites a
            // teacher's validated verdict, nor a proposal awaiting their eyes.
            let verdict: Verdict | null = grading ? verdictOf(grading) : null;
            let provisional = false;
            if (grading === null && attempt !== null && answer !== null && answer.payload !== null) {
              const graded = await preview.get(item.item.id)?.(attempt, answer.payload);
              if (graded) {
                verdict = graded.verdict;
                provisional = true;
                if (!entry.staff && graded.rate !== null) {
                  const rates = liveRates.get(item.item.id) ?? [];
                  rates.push(graded.rate);
                  liveRates.set(item.item.id, rates);
                }
              }
            }
            return {
              itemId: item.item.id,
              status: cellStatus(answer),
              verdict,
              provisional,
              points: grading && grading.state === "validated" ? grading.points : null,
              revision: answer?.revision ?? 0,
              summary:
                answer ? (summarize.get(item.item.id)?.(answer.payload) ?? null) : null,
            };
          }),
        ),
      };
    }),
  );

  // Every denominator below is the CLASS: a teacher testing their own quiz
  // must not move the completion of a question or its success rate.
  const classRows = rows.filter((r) => !r.staff);
  const started = classRows.filter((r) => r.attemptId !== null).length;
  const staffAttempts = new Set(
    rows.filter((r) => r.staff && r.attemptId !== null).map((r) => r.attemptId!),
  );
  return {
    evaluation: {
      id: evaluation.id,
      state: evaluation.state,
      startedAt: isoOrNull(evaluation.startedAt),
      pausedAt: isoOrNull(evaluation.pausedAt),
      closesAt: isoOrNull(evaluation.closesAt),
      serverNow: iso(input.now),
    },
    items: items.map((i) => ({
      id: i.item.id,
      position: i.item.position,
      points: i.item.points,
      type: i.question.type,
      internalName: i.question.internalName,
      milestone: i.item.milestone,
    })),
    rows,
    totals: items.map((item) => {
      const done = classRows.filter(
        (r) => r.cells.find((c) => c.itemId === item.item.id)?.status === "done",
      ).length;
      const graded = successRateOf(standing, item.item.id, staffAttempts);
      // Before anything is graded, the live rate of the answers that CAN be
      // graded now (ADR-020) — flagged, so the footer says which it is.
      const live = liveRates.get(item.item.id) ?? [];
      const provisional = graded === null && live.length > 0;
      return {
        itemId: item.item.id,
        completion: started === 0 ? 0 : Math.round((done / started) * 100) / 100,
        successRate: provisional
          ? Math.round((live.reduce((a, b) => a + b, 0) / live.length) * 100) / 100
          : graded,
        provisional,
      };
    }),
  };
}

/** The validated points of one attempt; `null` while nothing is graded yet. */
function pointsOf(
  standing: ReadonlyMap<PairKey, GradingRecord>,
  attemptId: string,
  items: readonly JoinedItem[],
): number | null {
  let total = 0;
  let seen = 0;
  for (const item of items) {
    const grading = standing.get(pairKey(attemptId, item.item.id));
    if (grading?.state !== "validated") continue;
    total += grading.points;
    seen += 1;
  }
  return seen === 0 ? null : Math.round(total * 100) / 100;
}

/**
 * The mean of `points / maxPoints` over the validated gradings of one item,
 * excluding the attempts of `skip` — the staff tests of ADR-018.
 */
function successRateOf(
  standing: ReadonlyMap<PairKey, GradingRecord>,
  itemId: string,
  skip: ReadonlySet<string>,
): number | null {
  let sum = 0;
  let n = 0;
  for (const grading of standing.values()) {
    if (grading.itemId !== itemId || grading.state !== "validated") continue;
    if (skip.has(grading.attemptId)) continue;
    if (grading.maxPoints <= 0) continue;
    sum += grading.points / grading.maxPoints;
    n += 1;
  }
  return n === 0 ? null : Math.round((sum / n) * 100) / 100;
}

/** F-DASH-05: one attempt opened in read mode, key included (teacher only). */
export async function attemptInspect(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
): Promise<AttemptInspect> {
  const items = await joinedItems(db, evaluation.id);
  const answered = await answersOf(db, attempt.id);
  // A teacher only ever inspects an attempt of THEIR evaluation, and a poll
  // has no inspector; the guest branch is here so the type is honest.
  const [student] = attempt.userId === null
    ? []
    : await db
        .select({ givenName: users.givenName, familyName: users.familyName, email: users.email })
        .from(users)
        .where(eq(users.id, attempt.userId))
        .limit(1);
  const ownerId = attempt.userId ?? attempt.id;
  const journal = await db
    .select()
    .from(attemptEvents)
    .where(eq(attemptEvents.attemptId, attempt.id))
    .orderBy(desc(attemptEvents.at))
    .limit(200);
  return {
    attempt: {
      id: attempt.id,
      userId: ownerId,
      displayName: student
        ? `${student.givenName ?? ""} ${student.familyName ?? ""}`.trim() || student.email
        : "Guest",
      pseudonym: uniquePseudonyms(evaluation.id, [ownerId]).get(ownerId) ?? "—",
      state: attempt.state,
      startedAt: isoOrNull(attempt.startedAt),
      deadlineAt: isoOrNull(attempt.deadlineAt),
      submittedAt: isoOrNull(attempt.submittedAt),
    },
    items: items.map((entry) => {
      const version = {
        config: entry.version.config,
        configVersion: entry.version.configVersion,
      };
      const answer = answered.get(entry.item.id) ?? null;
      return {
        item: {
          id: entry.item.id,
          position: entry.item.position,
          points: entry.item.points,
          type: entry.question.type,
          internalName: entry.question.internalName,
        },
        // The teacher sees exactly what the student saw, shuffle included.
        studentConfig: studentView({
          type: entry.question.type,
          version,
          seed: attempt.seed,
          itemId: entry.item.id,
          shuffle: settingsOf(evaluation).shuffleChoices && entry.question.shuffleable,
        }),
        answer: answer?.payload ?? null,
        revision: answer?.revision ?? 0,
        markedDone: answer?.markedDone ?? false,
        solution: solutionView({
          type: entry.question.type,
          version,
          seed: attempt.seed,
          itemId: entry.item.id,
        }),
      };
    }),
    events: journal.map((e) => ({ kind: e.kind, at: iso(e.at), details: e.details })),
    serverNow: iso(now),
  };
}

// --- Student home (F-LIVE-01) --------------------------------------------

export async function studentHome(db: Db, userId: string, now: Date): Promise<StudentHome> {
  const rows = await studentEvaluationRows(db, userId).orderBy(desc(evaluations.createdAt));

  // The grade of a released evaluation (WP6): the sum of the validated
  // gradings of the student's own attempt, converted by the evaluation's
  // scale. Two queries for the whole page, not one per card.
  const attemptIds = rows
    .map((r) => r.attempt?.id)
    .filter((id): id is string => id !== undefined && id !== null);
  const pointsPerAttempt = await pointsByAttempt(db, attemptIds);
  const released = rows.filter((r) => r.evaluation.releasedAt !== null);
  const totals = await totalPointsByEvaluation(db, [
    ...new Set(released.map((r) => r.evaluation.id)),
  ]);

  const gradeOf = (row: (typeof rows)[number]): number | null => {
    if (row.evaluation.releasedAt === null) return null;
    const total = totals.get(row.evaluation.id) ?? 0;
    const points = row.attempt ? (pointsPerAttempt.get(row.attempt.id) ?? 0) : 0;
    return gradeFromPoints(points, total, GradingScale.parse(row.evaluation.gradingScale));
  };

  const card = (row: (typeof rows)[number]): EvaluationCard => ({
    id: row.evaluation.id,
    title: row.evaluation.title,
    mode: row.evaluation.mode,
    state: row.evaluation.state,
    classroomId: row.evaluation.classroomId,
    classroomName: row.classroomName,
    courseCode: row.courseCode,
    opensAt: isoOrNull(row.evaluation.opensAt),
    closesAt: isoOrNull(row.evaluation.closesAt),
    durationS: row.evaluation.durationS,
    attemptId: row.attempt?.id ?? null,
    attemptState: row.attempt?.state ?? null,
    deadlineAt: isoOrNull(row.attempt?.deadlineAt ?? null),
    grade: gradeOf(row),
  });

  const open: EvaluationCard[] = [];
  const upcoming: EvaluationCard[] = [];
  const past: EvaluationCard[] = [];
  for (const row of rows) {
    const state = row.evaluation.state;
    if (state === "lobby" || state === "running" || state === "paused") open.push(card(row));
    else if (state === "scheduled") upcoming.push(card(row));
    else if (state !== "draft") past.push(card(row));
  }
  return { open, upcoming, past, serverNow: iso(now) };
}

// --- Ticker tasks (§5.3) --------------------------------------------------

/**
 * Step 1: expire everything past `deadline + GRACE_MS`. One conditional
 * UPDATE, so re-running a tick is free and catching up after an outage is
 * free (`RETURNING` tells us exactly what changed, and nothing else moved).
 */
export async function expireDueAttempts(
  db: Db,
  now: Date,
): Promise<{ id: string; evaluationId: string }[]> {
  const cutoff = new Date(now.getTime() - GRACE_MS);
  const closed = await db
    .update(attempts)
    .set({ state: "expired", closedAt: now, closedBy: "server", updatedAt: now })
    .where(
      and(
        eq(attempts.state, "in_progress"),
        isNotNull(attempts.deadlineAt),
        lte(attempts.deadlineAt, cutoff),
      ),
    )
    .returning({ id: attempts.id, evaluationId: attempts.evaluationId });
  for (const row of closed) {
    events.attemptClosed(
      row.evaluationId,
      { id: row.id } as AttemptRecord,
      "server",
      now,
    );
  }
  return closed;
}

/** Step 2: `scheduled → lobby` (or straight to `running` when lobby is skipped). */
export async function autoOpenScheduled(db: Db, now: Date): Promise<EvaluationRecord[]> {
  const due = await db
    .select()
    .from(evaluations)
    .where(
      and(
        eq(evaluations.state, "scheduled"),
        isNotNull(evaluations.opensAt),
        lte(evaluations.opensAt, now),
      ),
    );
  const moved: EvaluationRecord[] = [];
  for (const row of due) {
    const settings = settingsOf(row);
    const next =
      settings.lobby === "skip"
        ? await startEvaluation(db, row, now)
        : await applyState(db, row, "lobby", now);
    if (settings.lobby !== "skip") events.stateChanged(next, now);
    moved.push(next);
  }
  return moved;
}

/** Step 3: `lobby` + `lobby: auto` + everybody present → `running`. */
export async function autoStartFullLobbies(db: Db, now: Date): Promise<EvaluationRecord[]> {
  // `lobby` absent from the jsonb means its default, "manual": the SQL
  // predicate and `settingsOf(row).lobby === "auto"` select the same rows.
  const rows = await db
    .select()
    .from(evaluations)
    .where(and(eq(evaluations.state, "lobby"), sql`${evaluations.settings} ->> 'lobby' = 'auto'`));
  // An empty room never starts, so only an occupied lobby is worth counting.
  const occupied = rows.filter((row) => presence.count(row.id) > 0);
  const enrolledOf = await enrolledCounts(db, occupied);
  const moved: EvaluationRecord[] = [];
  for (const row of occupied) {
    const enrolled = enrolledOf.get(row.id) ?? 0;
    if (enrolled === 0 || presence.count(row.id) < enrolled) continue;
    moved.push(await startEvaluation(db, row, now));
  }
  return moved;
}

/**
 * When the ticker may close an evaluation: the last deadline anybody holds,
 * plus the grace of the autosave gate (D12). An accommodation and every
 * `+1/+5/+10 min` push an attempt past `closes_at`, and closing on
 * `closes_at` alone would take those minutes straight back (F-ORG-07).
 */
function autoCloseAt(closesAt: Date, latestAttemptDeadline: Date | null): Date {
  const last =
    latestAttemptDeadline !== null && latestAttemptDeadline.getTime() > closesAt.getTime()
      ? latestAttemptDeadline
      : closesAt;
  return new Date(last.getTime() + GRACE_MS);
}

/** Step 4: `running|paused` past `closes_at` → `closed` (+ enqueue grading). */
export async function autoCloseDue(
  db: Db,
  now: Date,
  app?: FastifyInstance,
): Promise<EvaluationRecord[]> {
  const due = await db
    .select()
    .from(evaluations)
    .where(
      and(
        inArray(evaluations.state, ["running", "paused"]),
        isNotNull(evaluations.closesAt),
        lte(evaluations.closesAt, now),
      ),
    );
  if (due.length === 0) return [];
  // Step 1 expired everything whose own deadline has passed, so what is
  // still `in_progress` here is a student who genuinely has time left.
  const latest = await db
    .select({ evaluationId: attempts.evaluationId, deadlineAt: max(attempts.deadlineAt) })
    .from(attempts)
    .where(
      and(
        inArray(attempts.evaluationId, due.map((row) => row.id)),
        eq(attempts.state, "in_progress"),
        isNotNull(attempts.deadlineAt),
      ),
    )
    .groupBy(attempts.evaluationId);
  const latestOf = new Map(latest.map((l) => [l.evaluationId, l.deadlineAt]));
  const moved: EvaluationRecord[] = [];
  for (const row of due) {
    const last = latestOf.get(row.id) ?? null;
    if (autoCloseAt(row.closesAt!, last).getTime() > now.getTime()) continue;
    moved.push(await closeEvaluation(db, row, now, "server", app));
  }
  return moved;
}

/** Step 5: connections silent for too long stop counting as present. */
export function sweepPresence(now: Date, idleMs: number): void {
  for (const change of presence.sweep(now, idleMs)) {
    events.presenceChanged(change.evaluationId, change.userId, change.online, change.lastSeenAt);
  }
}
