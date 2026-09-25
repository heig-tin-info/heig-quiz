/**
 * Taking an evaluation: the failures, deadlines, participants (users and
 * guests), attempt creation, item order, the three views, entering, the
 * write gate every student write passes, submitting, and the per-attempt
 * close/reopen (PLAN-MVP §4.4, §4.7). Imported through `./service.ts`.
 */
import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { and, count, desc, eq, inArray } from "drizzle-orm";

import {
  EvaluationSettings,
  GradingScale,
  type AttemptClosed,
  type AttemptItem,
  type AttemptOrLobby,
  type AttemptView,
  type EvaluationCard,
  type LobbyView,
  type StudentHome,
} from "@quiz/contracts";
import { shuffle, streamSeed } from "@quiz/core/rng";
import { GRACE_MS, attemptDeadline, bonusSeconds, gradeFromPoints, lockedItems } from "@quiz/domain";

import { iso, isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { answers, attempts, enrollments, evaluations, guestParticipants } from "../../db/schema.js";
import {
  feedbackOf,
  settingsOf,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import {
  joinedItem,
  joinedItems,
  studentEvaluationRows,
  totalPointsByEvaluation,
  totalPointsOf,
  cachedGrade,
} from "../evaluation/service.js";
import * as events from "./events.js";
import { enqueueEvaluationGrading } from "../grading/jobs.js";
import { pointsByAttempt } from "../grading/service.js";
import { presence } from "../realtime/presence.js";
import { isShuffleable, studentView } from "./studentView.js";

export type AttemptRecord = typeof attempts.$inferSelect;

export type AnswerRecord = typeof answers.$inferSelect;

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

/**
 * Reopening an attempt gives a student their paper back, which only means
 * something while the evaluation still takes writes: `running` or `paused`.
 * Anywhere else `closedReason` answers `evaluation_closed` to every write,
 * so a reopened attempt would be `in_progress` and yet unusable (#95). A
 * make-up session after the close is another feature: the grading pass has
 * already run.
 */
export class EvaluationNotLive extends LiveError {
  constructor() {
    super("evaluation_not_live", 409, "the evaluation is not running or paused");
  }
}

/**
 * Extra time on a finished evaluation (`closed`, `released`) moves a deadline
 * nobody can use any more: the attempts are closed and graded. The dashboard
 * offers no `+N min` there; the server refuses it the same way.
 */
export class EvaluationFinished extends LiveError {
  constructor() {
    super("evaluation_finished", 409, "the evaluation is already closed");
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

export class Irreversible extends LiveError {
  constructor(message = "forward_only: marking a question done cannot be undone") {
    super("irreversible", 409, message);
  }
}

/**
 * "I won't answer" on a question that holds an answer (issue #89). Skipping is
 * not a way to throw an answer away: the player only offers it on an empty
 * question, and flushes the autosave before asking.
 */
export class AlreadyAnswered extends LiveError {
  constructor() {
    super("answered", 409, "this question holds an answer");
  }
}

export class ItemLocked extends LiveError {
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

export class NotRunnable extends LiveError {
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
export class NothingToRun extends LiveError {
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
  if (!row) throw new LiveError("internal_error", 500, "guest vanished after insert");
  return row;
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
      skipped: answer?.skipped ?? false,
      flagged: answer?.flagged ?? false,
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
): Promise<AttemptView> {
  return viewOf(db, evaluation, {
    seed,
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
      totalPoints: totalPointsOf(items.map((i) => i.item)),
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
    navigation: settingsOf(evaluation).navigation,
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

export async function itemOf(
  db: Db,
  evaluationId: string,
  itemId: string,
): Promise<JoinedItem | null> {
  return joinedItem(db, evaluationId, itemId);
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
  const closed = await db
    .update(attempts)
    .set({ state: "expired", closedAt: now, closedBy: "teacher", updatedAt: now })
    .where(and(eq(attempts.id, attempt.id), eq(attempts.state, "in_progress")))
    .returning({ id: attempts.id });
  const row = (await attemptById(db, attempt.id))!;
  events.attemptClosed(evaluation.id, row, "teacher", now);
  // The pass of the evaluation's close has already run, and it ran while this
  // attempt was open: grade it now, alone (the pass never touches a cell a
  // teacher validated). Not on a `released` evaluation, whose grades are
  // published: those stay the teacher's to change, from the grading panel.
  if (app && closed.length > 0 && evaluation.state === "closed") {
    await enqueueEvaluationGrading(app, { evaluationId: evaluation.id, attemptIds: [row.id] });
  }
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
  if (evaluation.state !== "running" && evaluation.state !== "paused") {
    throw new EvaluationNotLive();
  }
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
    const hit = cachedGrade(row.evaluation, userId, row.attempt?.id ?? null);
    if (hit) return hit.grade;
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
