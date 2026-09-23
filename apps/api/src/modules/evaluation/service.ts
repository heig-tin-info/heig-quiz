/**
 * The `evaluation` module's business layer (PLAN-MVP §3.3, §4.3, §5.1).
 *
 * Three rules shape this file:
 *   - an item freezes ONE published question version at the moment it is
 *     added (F-EVAL-03); the only way to move it is `updateVersions`, and
 *     that door closes as soon as an attempt exists;
 *   - the state machine is a table, not a pile of `if`s: {@link TRANSITIONS}
 *     says what is legal and {@link guardTransition} says why an otherwise
 *     legal move is refused. The operational half (start, pause, close) is in
 *     `modules/live/service.ts`, which calls back into `applyState` here;
 *   - a structural change is refused once an attempt exists, because the
 *     wording, the order and the scale a student saw can never move under
 *     them.
 */
import { randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import {
  DEFAULT_MCQ_POLICY,
  EvaluationSettings,
  FeedbackPolicy,
  GradingScale,
  defaultFeedbackPolicy,
  defaultGradingScale,
  defaultSettings,
  type Evaluation,
  type EvaluationDetail,
  type EvaluationMode,
  type EvaluationSelf,
  type EvaluationPatch,
  type EvaluationState,
  type EvaluationSummary,
  type ItemPatch,
  type ItemRow,
  type McqPolicy,
  type ReleasedGrades,
} from "@quiz/contracts";

import { round2 } from "@quiz/domain";

import { iso, isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import {
  attempts,
  coursePools,
  classrooms,
  courses,
  enrollments,
  evaluationItems,
  evaluations,
  questionVersions,
  questions,
  users,
} from "../../db/schema.js";

export type EvaluationRecord = typeof evaluations.$inferSelect;
type ItemRecord = typeof evaluationItems.$inferSelect;

// --- Failures -------------------------------------------------------------

/** Base of everything this module refuses; the routes map `code` to a status. */
export class EvaluationError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "EvaluationError";
  }
}

export class IllegalTransition extends EvaluationError {
  constructor(
    readonly from: EvaluationState,
    readonly to: EvaluationState,
    reason?: string,
  ) {
    super("illegal_transition", 409, reason ?? `${from} -> ${to} is not a legal transition`);
  }
}

export class Locked extends EvaluationError {
  constructor(message = "an attempt exists: the structure is frozen") {
    super("locked", 409, message);
  }
}

class AttemptsExist extends EvaluationError {
  constructor() {
    super("attempts_exist", 409, "versions cannot be updated once an attempt exists");
  }
}

class NoPublishedVersion extends EvaluationError {
  constructor(readonly questionId: string) {
    super("no_published_version", 422, `question ${questionId} has no published version`);
  }
}

class QuestionNotInCourse extends EvaluationError {
  constructor(readonly questionId: string) {
    super("question_not_in_course", 422, `question ${questionId} is not in a pool of this course`);
  }
}

class PollNotImplemented extends EvaluationError {
  constructor() {
    super("not_implemented", 501, "poll mode is phase 2 (decision D7)");
  }
}

// --- State machine (§5.1) -------------------------------------------------

/**
 * The legal moves. `closed → draft` is the "reopen" arrow of §5.1 and is
 * guarded by "no attempt exists"; `closed → grading → closed → released`
 * belongs to WP6 and is listed so the table stays the one definition.
 */
const TRANSITIONS: Readonly<Record<EvaluationState, readonly EvaluationState[]>> = {
  draft: ["scheduled", "lobby", "running"],
  scheduled: ["draft", "lobby", "running", "closed"],
  lobby: ["draft", "running", "closed"],
  running: ["paused", "closed"],
  paused: ["running", "closed"],
  closed: ["draft", "grading", "released"],
  grading: ["closed", "released"],
  // `released → closed` is the withdrawal of a release (`unreleaseResults`).
  released: ["released", "closed"],
};

export function isLegalTransition(from: EvaluationState, to: EvaluationState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** F-EVAL-04: an `exam` must announce when it ends, one way or the other. */
function timingIsValid(row: {
  mode: EvaluationMode;
  settings: EvaluationSettings;
  durationS: number | null;
  opensAt: Date | null;
  closesAt: Date | null;
}): boolean {
  switch (row.settings.timing) {
    case "duration":
      return row.durationS !== null && row.durationS > 0;
    case "deadline":
      // `opensAt` is required too: it is the base of the accommodation
      // window in this timing (decision D8).
      return row.closesAt !== null && row.opensAt !== null;
    case "manual":
      return row.mode !== "exam";
  }
}

interface TransitionContext {
  itemCount: number;
  attemptCount: number;
}

/**
 * Why an otherwise legal move is refused. Separated from
 * {@link isLegalTransition} so the error tells a teacher what to fix.
 */
export function guardTransition(
  row: EvaluationRecord,
  to: EvaluationState,
  ctx: TransitionContext,
): void {
  const from = row.state;
  if (!isLegalTransition(from, to)) throw new IllegalTransition(from, to);

  if (to === "scheduled" || to === "lobby" || to === "running") {
    if (ctx.itemCount === 0) {
      throw new IllegalTransition(from, to, "an evaluation needs at least one question");
    }
    if (!timingIsValid({ ...row, settings: settingsOf(row) })) {
      throw new IllegalTransition(from, to, "the timing settings are incomplete (F-EVAL-04)");
    }
  }
  if (to === "paused" && row.mode !== "exam") {
    throw new IllegalTransition(from, to, "only an exam can be paused");
  }
  if (to === "draft" && ctx.attemptCount > 0) {
    throw new IllegalTransition(from, to, "an attempt exists: the evaluation cannot be reopened");
  }
}

// --- Reads ----------------------------------------------------------------

export function settingsOf(row: EvaluationRecord): EvaluationSettings {
  return EvaluationSettings.parse(row.settings);
}

export function feedbackOf(row: EvaluationRecord): FeedbackPolicy {
  return FeedbackPolicy.parse(row.feedbackPolicy);
}

/** The grade scale of F-EVAL-10; the results module never parses the jsonb itself. */
export function scaleOf(row: EvaluationRecord): GradingScale {
  return GradingScale.parse(row.gradingScale);
}

export function toEvaluation(row: EvaluationRecord): Evaluation {
  return {
    id: row.id,
    classroomId: row.classroomId,
    title: row.title,
    mode: row.mode,
    state: row.state,
    settings: settingsOf(row),
    gradingScale: GradingScale.parse(row.gradingScale),
    feedbackPolicy: feedbackOf(row),
    mcqPolicy: row.mcqPolicy,
    opensAt: isoOrNull(row.opensAt),
    closesAt: isoOrNull(row.closesAt),
    durationS: row.durationS,
    accessCode: row.accessCode,
    ipAllowlist: row.ipAllowlist,
    startedAt: isoOrNull(row.startedAt),
    pausedAt: isoOrNull(row.pausedAt),
    closedAt: isoOrNull(row.closedAt),
    releasedAt: isoOrNull(row.releasedAt),
    modifiedAfterRelease: row.modifiedAfterRelease,
    createdAt: iso(row.createdAt),
  };
}

/**
 * The per-type settings of this evaluation, as `GradeContext.defaults` — what
 * a question config that says "inherit" defers to (invariant: the core knows
 * no type's shape, each type parses its own entry).
 *
 * One entry today, `mcq`; a second type with an evaluation-level setting adds
 * its key here and nowhere else.
 */
export function gradeDefaults(row: EvaluationRecord): Readonly<Record<string, unknown>> {
  return { mcq: { policy: row.mcqPolicy } };
}

/**
 * The MCQ policy a NEW evaluation of this teacher starts with. A user who
 * never opened the settings page has none, and the default is the one nobody
 * has to be told about.
 */
async function preferredMcqPolicy(db: Db, userId: string): Promise<McqPolicy> {
  const [row] = await db
    .select({ policy: users.mcqPolicy })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.policy ?? DEFAULT_MCQ_POLICY;
}

export async function attemptCount(db: Db, evaluationId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(attempts)
    .where(eq(attempts.evaluationId, evaluationId));
  return row?.n ?? 0;
}

/** The frozen version of every item, joined with the question it came from. */
export interface JoinedItem {
  item: ItemRecord;
  version: typeof questionVersions.$inferSelect;
  question: typeof questions.$inferSelect;
}

const selectJoinedItems = (db: Db) =>
  db
    .select({ item: evaluationItems, version: questionVersions, question: questions })
    .from(evaluationItems)
    .innerJoin(questionVersions, eq(evaluationItems.questionVersionId, questionVersions.id))
    .innerJoin(questions, eq(questionVersions.questionId, questions.id));

export async function joinedItems(db: Db, evaluationId: string): Promise<JoinedItem[]> {
  return selectJoinedItems(db)
    .where(eq(evaluationItems.evaluationId, evaluationId))
    .orderBy(asc(evaluationItems.position));
}

/** One item of one evaluation, by primary key — not the whole list filtered. */
export async function joinedItem(
  db: Db,
  evaluationId: string,
  itemId: string,
): Promise<JoinedItem | null> {
  const [row] = await selectJoinedItems(db)
    .where(and(eq(evaluationItems.id, itemId), eq(evaluationItems.evaluationId, evaluationId)))
    .limit(1);
  return row ?? null;
}

/**
 * Every evaluation of every classroom the student holds a claimed seat in,
 * with the student's own attempt when there is one: what the student home
 * and the results page are both drawn from. Returned unawaited so that a
 * caller may still order it.
 */
export function studentEvaluationRows(db: Db, userId: string) {
  return db
    .select({
      evaluation: evaluations,
      classroomName: classrooms.name,
      courseCode: courses.code,
      attempt: attempts,
    })
    .from(enrollments)
    .innerJoin(classrooms, eq(enrollments.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .innerJoin(evaluations, eq(evaluations.classroomId, classrooms.id))
    .leftJoin(
      attempts,
      and(eq(attempts.evaluationId, evaluations.id), eq(attempts.userId, userId)),
    )
    .where(eq(enrollments.userId, userId));
}

/** The total points of each evaluation, in one grouped query. */
export async function totalPointsByEvaluation(
  db: Db,
  evaluationIds: readonly string[],
): Promise<Map<string, number>> {
  if (evaluationIds.length === 0) return new Map();
  const rows = await db
    .select({
      evaluationId: evaluationItems.evaluationId,
      points: sql<string>`sum(${evaluationItems.points})`,
    })
    .from(evaluationItems)
    .where(inArray(evaluationItems.evaluationId, [...evaluationIds]))
    .groupBy(evaluationItems.evaluationId);
  return new Map(rows.map((r) => [r.evaluationId, round2(Number(r.points))]));
}

/** The highest published version number of each question, in one query. */
async function latestNumbers(db: Db, questionIds: string[]): Promise<Map<string, number>> {
  if (questionIds.length === 0) return new Map();
  const rows = await db
    .select({
      questionId: questionVersions.questionId,
      latest: sql<number>`max(${questionVersions.number})`,
    })
    .from(questionVersions)
    .where(
      and(
        inArray(questionVersions.questionId, questionIds),
        isNotNull(questionVersions.number),
      ),
    )
    .groupBy(questionVersions.questionId);
  return new Map(rows.map((r) => [r.questionId, Number(r.latest)]));
}

export async function itemRows(db: Db, evaluationId: string): Promise<ItemRow[]> {
  const joined = await joinedItems(db, evaluationId);
  const latest = await latestNumbers(db, [...new Set(joined.map((j) => j.question.id))]);
  return joined.map((j) => ({
    id: j.item.id,
    position: j.item.position,
    points: j.item.points,
    milestone: j.item.milestone,
    questionId: j.question.id,
    questionVersionId: j.version.id,
    type: j.question.type,
    internalName: j.question.internalName,
    versionNumber: j.version.number ?? 0,
    latestVersionNumber: latest.get(j.question.id) ?? null,
    deprecated: j.version.deprecatedAt !== null,
  }));
}

/**
 * The total points of an evaluation: the sum of its items' points, rounded by
 * `@quiz/domain#round2` like every other number of the platform (decision
 * D13). The one definition behind the builder, the attempt view, the live
 * dashboard, the results and the feedback page, which show the same number.
 * A caller holding `JoinedItem`s passes `items.map((i) => i.item)`.
 */
export const totalPointsOf = (rows: readonly { points: number }[]): number =>
  round2(rows.reduce((sum, r) => sum + r.points, 0));

export const staleOf = (rows: readonly ItemRow[]): string[] =>
  rows.filter((r) => r.latestVersionNumber !== null && r.latestVersionNumber > r.versionNumber)
    .map((r) => r.id);

/**
 * The attempts of an evaluation that belong to a STAFF seat of its classroom
 * — a teacher's own test walk (ADR-018).
 *
 * ONE query, shared by the dashboard, the grading panel and the results, so
 * the three screens can never disagree about which rows are a teacher's.
 */
export async function staffAttemptIds(
  db: Db,
  evaluation: EvaluationRecord,
): Promise<Set<string>> {
  const rows = await db
    .select({ id: attempts.id })
    .from(attempts)
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.classroomId, evaluation.classroomId),
        eq(enrollments.userId, attempts.userId),
        eq(enrollments.staff, true),
      ),
    )
    .where(eq(attempts.evaluationId, evaluation.id));
  return new Set(rows.map((r) => r.id));
}

/**
 * The staff seats of a classroom that actually took the evaluation, in the
 * shape the roster queries of the dashboard and the results use.
 *
 * A staff seat with no attempt is NOT returned: the teacher's name would
 * otherwise sit in every grid of every quiz they never opened.
 */
export async function staffRosterWithAttempt(
  db: Db,
  evaluation: EvaluationRecord,
): Promise<
  { userId: string; nom: string; prenom: string; email: string; timeBonusPercent: number }[]
> {
  return db
    .select({
      userId: sql<string>`${enrollments.userId}`,
      nom: enrollments.nom,
      prenom: enrollments.prenom,
      email: enrollments.email,
      timeBonusPercent: enrollments.timeBonusPercent,
    })
    .from(enrollments)
    .innerJoin(
      attempts,
      and(eq(attempts.userId, enrollments.userId), eq(attempts.evaluationId, evaluation.id)),
    )
    .where(
      and(eq(enrollments.classroomId, evaluation.classroomId), eq(enrollments.staff, true)),
    )
    .orderBy(asc(enrollments.nom), asc(enrollments.prenom));
}

/**
 * What the reader of this page is, seen from the evaluation (ADR-018): the
 * seat they hold in its classroom and the test attempt they took with it.
 *
 * Two tables of two other modules, read by join and never written, which is
 * what a module is allowed to do (CLAUDE.md, Conventions). It is NOT a call
 * into `live/service.ts`: `live` already imports this file, and the cycle
 * would be the price of saving four lines.
 */
async function selfOf(
  db: Db,
  row: EvaluationRecord,
  userId: string,
): Promise<EvaluationSelf> {
  const [seat] = await db
    .select({ staff: enrollments.staff })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.classroomId, row.classroomId),
        eq(enrollments.userId, userId),
      ),
    )
    .limit(1);
  const [attempt] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(and(eq(attempts.evaluationId, row.id), eq(attempts.userId, userId)))
    .limit(1);
  return {
    seat: seat !== undefined,
    staffSeat: seat?.staff ?? false,
    attemptId: attempt?.id ?? null,
  };
}

export async function evaluationDetail(
  db: Db,
  row: EvaluationRecord,
  viewerId: string,
): Promise<EvaluationDetail> {
  const items = await itemRows(db, row.id);
  const attemptsSoFar = await attemptCount(db, row.id);
  return {
    evaluation: toEvaluation(row),
    items,
    totalPoints: totalPointsOf(items),
    staleItems: staleOf(items),
    attemptCount: attemptsSoFar,
    editable: attemptsSoFar === 0,
    self: await selfOf(db, row, viewerId),
  };
}

export async function listEvaluations(
  db: Db,
  classroomId: string,
): Promise<EvaluationSummary[]> {
  const rows = await db
    .select()
    .from(evaluations)
    .where(eq(evaluations.classroomId, classroomId))
    .orderBy(desc(evaluations.createdAt));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const itemStats = await db
    .select({
      evaluationId: evaluationItems.evaluationId,
      n: count(),
      points: sql<number>`coalesce(sum(${evaluationItems.points}), 0)`,
    })
    .from(evaluationItems)
    .where(inArray(evaluationItems.evaluationId, ids))
    .groupBy(evaluationItems.evaluationId);
  const attemptStats = await db
    .select({ evaluationId: attempts.evaluationId, n: count() })
    .from(attempts)
    .where(inArray(attempts.evaluationId, ids))
    .groupBy(attempts.evaluationId);
  const items = new Map(itemStats.map((s) => [s.evaluationId, s]));
  const tries = new Map(attemptStats.map((s) => [s.evaluationId, s.n]));
  return rows.map((r) => ({
    id: r.id,
    classroomId: r.classroomId,
    title: r.title,
    mode: r.mode,
    state: r.state,
    itemCount: items.get(r.id)?.n ?? 0,
    totalPoints: Number(items.get(r.id)?.points ?? 0),
    attemptCount: tries.get(r.id) ?? 0,
    opensAt: isoOrNull(r.opensAt),
    closesAt: isoOrNull(r.closesAt),
    createdAt: iso(r.createdAt),
  }));
}

// --- Writes ---------------------------------------------------------------

/**
 * The two presets of §4.3. An exam is timed, forward-only-ish and silent
 * until release; an exercise is open and gives feedback immediately.
 */
function presetSettings(preset: "exam" | "exercise"): {
  settings: EvaluationSettings;
  feedbackPolicy: FeedbackPolicy;
} {
  if (preset === "exercise") {
    return {
      settings: EvaluationSettings.parse({ timing: "manual", lobby: "skip", navigation: "free" }),
      feedbackPolicy: FeedbackPolicy.parse({
        when: "immediate",
        showKey: true,
        showExplanation: true,
      }),
    };
  }
  return { settings: defaultSettings(), feedbackPolicy: defaultFeedbackPolicy() };
}

export async function createEvaluation(
  db: Db,
  input: {
    classroomId: string;
    title: string;
    mode: EvaluationMode;
    preset?: "exam" | "exercise" | undefined;
    createdBy: string;
  },
): Promise<EvaluationRecord> {
  if (input.mode === "poll") throw new PollNotImplemented();
  const preset = presetSettings(input.preset ?? (input.mode === "exercise" ? "exercise" : "exam"));
  const id = randomUUID();
  // The creator's preference SEEDS the evaluation and is then forgotten:
  // changing the preference later never moves an evaluation that exists.
  const mcqPolicy = await preferredMcqPolicy(db, input.createdBy);
  await db.insert(evaluations).values({
    id,
    classroomId: input.classroomId,
    title: input.title,
    mode: input.mode,
    state: "draft",
    settings: preset.settings,
    gradingScale: defaultGradingScale(),
    feedbackPolicy: preset.feedbackPolicy,
    mcqPolicy,
    createdBy: input.createdBy,
  });
  return (await byId(db, id))!;
}

/**
 * The POLL path (F-LIVE-13, ADR-014): one question, created AND started in
 * the same call, with the session code already on it.
 *
 * It lives here rather than in `modules/poll/` because `evaluations` and
 * `evaluation_items` are this module's tables and no other module writes
 * them (CLAUDE.md, Conventions). {@link createEvaluation} keeps refusing
 * `mode: "poll"`: a poll is never authored item by item, so the generic
 * route has nothing to offer it.
 *
 * Deliberate differences from {@link addItems}: the question is NOT required
 * to sit in a pool of the classroom's course — a poll runs a question of the
 * teacher's personal pool, which is linked to nothing — and the two writes
 * are one transaction, so a poll is never half-created.
 */
export async function createPollEvaluation(
  db: Db,
  input: {
    classroomId: string;
    title: string;
    createdBy: string;
    questionId: string;
    accessCode: string;
    anonymous: boolean;
    defaultPoints: (type: string, version: typeof questionVersions.$inferSelect) => number;
    now: Date;
  },
): Promise<{ evaluation: EvaluationRecord; item: ItemRecord }> {
  const [question] = await db
    .select()
    .from(questions)
    .where(eq(questions.id, input.questionId))
    .limit(1);
  if (!question || question.deletedAt !== null) throw new QuestionNotInCourse(input.questionId);
  const version = (await latestPublished(db, [input.questionId])).get(input.questionId);
  if (!version) throw new NoPublishedVersion(input.questionId);

  // The exercise preset, plus the two poll switches. `immediate` feedback
  // with the key HELD BACK: the reveal is the teacher's act, and it moves
  // `settings.poll.revealed` and `feedbackPolicy.showKey` together.
  const settings: EvaluationSettings = EvaluationSettings.parse({
    ...presetSettings("exercise").settings,
    poll: { anonymous: input.anonymous, revealed: false },
  });
  const feedbackPolicy: FeedbackPolicy = FeedbackPolicy.parse({
    when: "immediate",
    showAnswer: true,
    showKey: false,
    showExplanation: false,
  });

  const id = randomUUID();
  const itemId = randomUUID();
  const mcqPolicy = await preferredMcqPolicy(db, input.createdBy);
  await db.transaction(async (tx) => {
    await tx.insert(evaluations).values({
      id,
      classroomId: input.classroomId,
      title: input.title,
      mode: "poll",
      // A poll opens on the spot: there is no lobby, no schedule and no
      // draft to review (glossary §1.4).
      state: "running",
      settings,
      gradingScale: defaultGradingScale(),
      feedbackPolicy,
      mcqPolicy,
      accessCode: input.accessCode,
      startedAt: input.now,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    });
    await tx.insert(evaluationItems).values({
      id: itemId,
      evaluationId: id,
      position: 0,
      questionVersionId: version.id,
      points: input.defaultPoints(question.type, version),
      milestone: false,
      createdAt: input.now,
    });
  });
  const [item] = await db
    .select()
    .from(evaluationItems)
    .where(eq(evaluationItems.id, itemId))
    .limit(1);
  return { evaluation: (await byId(db, id))!, item: item! };
}

/**
 * A handle or an open transaction: the state change below is also the second
 * half of a withdrawal that must not land alone (`unreleaseResults`).
 */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function byId(db: DbOrTx, id: string): Promise<EvaluationRecord | null> {
  const [row] = await db.select().from(evaluations).where(eq(evaluations.id, id)).limit(1);
  return row ?? null;
}

/**
 * Fields a teacher may still change once a student has an attempt: the title,
 * the access control and the feedback policy. Everything else decides what a
 * student sees or how long they have, and is frozen (F-EVAL-03).
 */
const SAFE_FIELDS = new Set(["title", "accessCode", "ipAllowlist", "feedbackPolicy"]);

function isStructural(patch: EvaluationPatch): boolean {
  return Object.keys(patch).some((k) => !SAFE_FIELDS.has(k));
}

export async function patchEvaluation(
  db: Db,
  row: EvaluationRecord,
  patch: EvaluationPatch,
  ctx: { attemptCount: number },
): Promise<EvaluationRecord> {
  if (ctx.attemptCount > 0 && isStructural(patch)) throw new Locked();
  const next: Partial<typeof evaluations.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.settings !== undefined) {
    next.settings = EvaluationSettings.parse({ ...settingsOf(row), ...patch.settings });
  }
  if (patch.gradingScale !== undefined) next.gradingScale = patch.gradingScale;
  if (patch.mcqPolicy !== undefined) next.mcqPolicy = patch.mcqPolicy;
  if (patch.feedbackPolicy !== undefined) {
    next.feedbackPolicy = FeedbackPolicy.parse({ ...feedbackOf(row), ...patch.feedbackPolicy });
  }
  if (patch.opensAt !== undefined) next.opensAt = patch.opensAt === null ? null : new Date(patch.opensAt);
  if (patch.closesAt !== undefined) {
    next.closesAt = patch.closesAt === null ? null : new Date(patch.closesAt);
  }
  if (patch.durationS !== undefined) next.durationS = patch.durationS;
  if (patch.accessCode !== undefined) next.accessCode = patch.accessCode;
  if (patch.ipAllowlist !== undefined) next.ipAllowlist = patch.ipAllowlist;

  // `immediate` feedback during an exam would hand the key out mid-exam
  // (F-EVAL-11): the policy is silently clamped, never accepted as written.
  const feedback = (next.feedbackPolicy ?? feedbackOf(row)) as FeedbackPolicy;
  const mode = row.mode;
  if (mode === "exam" && feedback.when === "immediate") {
    next.feedbackPolicy = { ...feedback, when: "on_release" };
  }

  await db.update(evaluations).set(next).where(eq(evaluations.id, row.id));
  return (await byId(db, row.id))!;
}

export async function deleteEvaluation(db: Db, row: EvaluationRecord): Promise<void> {
  await db.delete(evaluations).where(eq(evaluations.id, row.id));
}

// --- Narrow writers for the other modules ----------------------------------
//
// `evaluations` and `evaluation_items` belong to this module (CLAUDE.md,
// Conventions). What `live`, `poll`, `results` and `grading` need to change
// on them goes through one of these, each carrying its own `updatedAt` bump,
// rather than through an UPDATE of their own.

/** `live.extendTime`: the shared deadline of a `deadline`-timed evaluation. */
export async function setClosesAt(db: DbOrTx, id: string, closesAt: Date, now: Date): Promise<void> {
  await db.update(evaluations).set({ closesAt, updatedAt: now }).where(eq(evaluations.id, id));
}

/** `poll.setRevealed`: the poll switches and the feedback policy, moved together. */
export async function setPollSettings(
  db: DbOrTx,
  id: string,
  values: Required<Pick<typeof evaluations.$inferInsert, "settings" | "feedbackPolicy">>,
  now: Date,
): Promise<void> {
  await db
    .update(evaluations)
    .set({ ...values, updatedAt: now })
    .where(eq(evaluations.id, id));
}

/** `results.releaseResults`: the frozen grades (ADR-012) and the state they imply. */
export async function setRelease(
  db: DbOrTx,
  id: string,
  release: { releasedAt: Date; releasedGrades: ReleasedGrades },
  now: Date,
): Promise<void> {
  await db
    .update(evaluations)
    .set({ ...release, modifiedAfterRelease: false, state: "released", updatedAt: now })
    .where(eq(evaluations.id, id));
}

/** `results.unreleaseResults`: the release pair, cleared (the state moves separately). */
export async function clearRelease(db: DbOrTx, id: string, now: Date): Promise<void> {
  await db
    .update(evaluations)
    .set({ releasedAt: null, releasedGrades: null, modifiedAfterRelease: false, updatedAt: now })
    .where(eq(evaluations.id, id));
}

/** F-GRADE-09: a correction landed after the release. */
export async function setModifiedAfterRelease(db: DbOrTx, id: string, now: Date): Promise<void> {
  await db
    .update(evaluations)
    .set({ modifiedAfterRelease: true, updatedAt: now })
    .where(eq(evaluations.id, id));
}

/**
 * A regrade onto another published version of the same question (F-GRADE-06).
 * `evaluation_items` has no `updatedAt` of its own.
 */
export async function retargetItemVersion(
  db: DbOrTx,
  itemId: string,
  questionVersionId: string,
): Promise<void> {
  await db
    .update(evaluationItems)
    .set({ questionVersionId })
    .where(eq(evaluationItems.id, itemId));
}

/**
 * Applies a state change with its side effects on the row itself, ONLY if the
 * row is still in the state the caller read. `null` means somebody else moved
 * it first — a double-clicked `POST /resume`, or a second ticker process
 * under `WORKER_MODE` — and the caller must then skip its own side effects,
 * because they have already been applied once (a second `pausedFor` would
 * double every deadline).
 *
 * The side effects on the ATTEMPTS (starting them, shifting their deadlines,
 * expiring them) belong to `modules/live/service.ts`, which calls this.
 */
export async function tryApplyState(
  db: DbOrTx,
  row: EvaluationRecord,
  to: EvaluationState,
  now: Date,
): Promise<EvaluationRecord | null> {
  const next: Partial<typeof evaluations.$inferInsert> = { state: to, updatedAt: now };
  if (to === "running") {
    if (row.startedAt === null) next.startedAt = now;
    next.pausedAt = null;
  }
  if (to === "paused") next.pausedAt = now;
  if (to === "closed") next.closedAt = now;
  if (to === "draft") {
    // A reopened evaluation forgets that it ever ran; no attempt exists, so
    // there is nothing whose clock those instants would contradict.
    next.startedAt = null;
    next.pausedAt = null;
    next.closedAt = null;
  }
  const updated = await db
    .update(evaluations)
    .set(next)
    // The compare-and-set: the row must still be where the caller saw it.
    .where(and(eq(evaluations.id, row.id), eq(evaluations.state, row.state)))
    .returning({ id: evaluations.id });
  if (updated.length === 0) return null;
  return (await byId(db, row.id))!;
}

/**
 * {@link tryApplyState} for a caller with nothing to undo: it hands back the
 * row as it stands, moved or already moved by somebody else.
 */
export async function applyState(
  db: DbOrTx,
  row: EvaluationRecord,
  to: EvaluationState,
  now: Date,
): Promise<EvaluationRecord> {
  return (await tryApplyState(db, row, to, now)) ?? (await byId(db, row.id))!;
}

/** The authoring transitions of §4.3; guards included. */
export async function transition(
  db: Db,
  row: EvaluationRecord,
  to: EvaluationState,
  now: Date,
): Promise<EvaluationRecord> {
  if (row.mode === "poll") throw new PollNotImplemented();
  const items = await db
    .select({ n: count() })
    .from(evaluationItems)
    .where(eq(evaluationItems.evaluationId, row.id));
  guardTransition(row, to, {
    itemCount: items[0]?.n ?? 0,
    attemptCount: await attemptCount(db, row.id),
  });
  return applyState(db, row, to, now);
}

// --- Items ----------------------------------------------------------------

/** The pools this evaluation may draw questions from (F-EVAL-01). */
async function coursePoolIds(db: Db, evaluationId: string): Promise<Set<string>> {
  const rows = await db
    .select({ poolId: coursePools.poolId })
    .from(evaluations)
    .innerJoin(classrooms, eq(evaluations.classroomId, classrooms.id))
    .innerJoin(coursePools, eq(coursePools.courseId, classrooms.courseId))
    .where(eq(evaluations.id, evaluationId));
  return new Set(rows.map((r) => r.poolId));
}

/** The latest PUBLISHED version of each question, or null when there is none. */
async function latestPublished(
  db: Db,
  questionIds: string[],
): Promise<Map<string, typeof questionVersions.$inferSelect>> {
  if (questionIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(questionVersions)
    .where(
      and(inArray(questionVersions.questionId, questionIds), isNotNull(questionVersions.number)),
    )
    .orderBy(asc(questionVersions.questionId), desc(questionVersions.number));
  const out = new Map<string, typeof questionVersions.$inferSelect>();
  for (const row of rows) if (!out.has(row.questionId)) out.set(row.questionId, row);
  return out;
}

async function nextPosition(db: Db, evaluationId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${evaluationItems.position})` })
    .from(evaluationItems)
    .where(eq(evaluationItems.evaluationId, evaluationId));
  return (row?.max === null || row?.max === undefined ? -1 : Number(row.max)) + 1;
}

/**
 * Adds questions at the end, each frozen on its current published version
 * (F-EVAL-03). Points default to `type.defaultPoints` — supplied by the
 * caller, so this file never imports the registry.
 */
export async function addItems(
  db: Db,
  row: EvaluationRecord,
  questionIds: string[],
  defaultPoints: (type: string, version: typeof questionVersions.$inferSelect) => number,
  ctx: { attemptCount: number },
): Promise<ItemRow[]> {
  if (ctx.attemptCount > 0) throw new Locked();
  const allowed = await coursePoolIds(db, row.id);
  const found = await db.select().from(questions).where(inArray(questions.id, questionIds));
  const byQuestion = new Map(found.map((q) => [q.id, q]));
  const versions = await latestPublished(db, questionIds);

  let position = await nextPosition(db, row.id);
  const values: (typeof evaluationItems.$inferInsert)[] = [];
  for (const questionId of questionIds) {
    const question = byQuestion.get(questionId);
    if (!question || question.deletedAt !== null || !allowed.has(question.poolId)) {
      throw new QuestionNotInCourse(questionId);
    }
    const version = versions.get(questionId);
    if (!version) throw new NoPublishedVersion(questionId);
    values.push({
      id: randomUUID(),
      evaluationId: row.id,
      position: position++,
      questionVersionId: version.id,
      points: defaultPoints(question.type, version),
      milestone: false,
    });
  }
  if (values.length > 0) await db.insert(evaluationItems).values(values);
  return itemRows(db, row.id);
}

export async function patchItem(
  db: Db,
  row: EvaluationRecord,
  itemId: string,
  patch: ItemPatch,
  ctx: { attemptCount: number },
): Promise<ItemRow[]> {
  if (ctx.attemptCount > 0) throw new Locked();
  const next: Partial<typeof evaluationItems.$inferInsert> = {};
  if (patch.points !== undefined) next.points = patch.points;
  if (patch.milestone !== undefined) next.milestone = patch.milestone;
  await db
    .update(evaluationItems)
    .set(next)
    .where(and(eq(evaluationItems.id, itemId), eq(evaluationItems.evaluationId, row.id)));
  return itemRows(db, row.id);
}

export async function deleteItem(
  db: Db,
  row: EvaluationRecord,
  itemId: string,
  ctx: { attemptCount: number },
): Promise<ItemRow[]> {
  if (ctx.attemptCount > 0) throw new Locked();
  await db
    .delete(evaluationItems)
    .where(and(eq(evaluationItems.id, itemId), eq(evaluationItems.evaluationId, row.id)));
  // Positions stay dense: the grid, the CSV export and `forward_only` all
  // read `position` as an index, not as an opaque sort key.
  const remaining = await db
    .select()
    .from(evaluationItems)
    .where(eq(evaluationItems.evaluationId, row.id))
    .orderBy(asc(evaluationItems.position));
  await renumber(db, row.id, remaining.map((r) => r.id));
  return itemRows(db, row.id);
}

/**
 * Two-phase renumbering: every row is first pushed out of the way, then
 * given its final position. `(evaluation_id, position)` is unique and NOT
 * deferrable (see `db/evaluation.ts`), so a one-pass UPDATE would collide
 * with itself on any swap.
 */
async function renumber(db: Db, evaluationId: string, orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return;
  await db.transaction(async (tx) => {
    await tx
      .update(evaluationItems)
      .set({ position: sql`${evaluationItems.position} + 100000` })
      .where(eq(evaluationItems.evaluationId, evaluationId));
    for (const [index, id] of orderedIds.entries()) {
      await tx
        .update(evaluationItems)
        .set({ position: index })
        .where(
          and(eq(evaluationItems.id, id), eq(evaluationItems.evaluationId, evaluationId)),
        );
    }
  });
}

export async function reorderItems(
  db: Db,
  row: EvaluationRecord,
  itemIds: string[],
  ctx: { attemptCount: number },
): Promise<ItemRow[]> {
  if (ctx.attemptCount > 0) throw new Locked();
  const existing = await db
    .select({ id: evaluationItems.id })
    .from(evaluationItems)
    .where(eq(evaluationItems.evaluationId, row.id));
  const known = new Set(existing.map((e) => e.id));
  // Anything the caller forgot keeps its relative place at the end, so a
  // stale browser tab can never drop an item by omitting it.
  const ordered = [...itemIds.filter((id) => known.has(id))];
  for (const id of existing.map((e) => e.id)) if (!ordered.includes(id)) ordered.push(id);
  await renumber(db, row.id, ordered);
  return itemRows(db, row.id);
}

/**
 * The one-click "update to the latest version" of F-EVAL-03. Refused as soon
 * as an attempt exists: a student who already answered would silently be
 * answering another question.
 */
export async function updateVersions(
  db: Db,
  row: EvaluationRecord,
  itemIds: string[] | undefined,
  ctx: { attemptCount: number },
): Promise<ItemRow[]> {
  if (ctx.attemptCount > 0) throw new AttemptsExist();
  const joined = await joinedItems(db, row.id);
  const targets = itemIds === undefined ? joined : joined.filter((j) => itemIds.includes(j.item.id));
  const versions = await latestPublished(db, [...new Set(targets.map((j) => j.question.id))]);
  for (const target of targets) {
    const latest = versions.get(target.question.id);
    if (!latest || latest.id === target.version.id) continue;
    await db
      .update(evaluationItems)
      .set({ questionVersionId: latest.id })
      .where(eq(evaluationItems.id, target.item.id));
  }
  return itemRows(db, row.id);
}

/** F-EVAL-14: same items, same settings, new draft, possibly another classroom. */
export async function duplicateEvaluation(
  db: Db,
  row: EvaluationRecord,
  input: { classroomId: string; title: string; createdBy: string },
): Promise<EvaluationRecord> {
  const id = randomUUID();
  const items = await db
    .select()
    .from(evaluationItems)
    .where(eq(evaluationItems.evaluationId, row.id))
    .orderBy(asc(evaluationItems.position));
  await db.transaction(async (tx) => {
    await tx.insert(evaluations).values({
      id,
      classroomId: input.classroomId,
      title: input.title,
      mode: row.mode,
      state: "draft",
      settings: row.settings,
      gradingScale: row.gradingScale,
      feedbackPolicy: row.feedbackPolicy,
      mcqPolicy: row.mcqPolicy,
      opensAt: row.opensAt,
      closesAt: row.closesAt,
      durationS: row.durationS,
      accessCode: row.accessCode,
      ipAllowlist: row.ipAllowlist,
      createdBy: input.createdBy,
    });
    if (items.length > 0) {
      await tx.insert(evaluationItems).values(
        items.map((item) => ({
          id: randomUUID(),
          evaluationId: id,
          position: item.position,
          // The copy points at the SAME frozen versions: duplicating an
          // evaluation must not silently upgrade its questions.
          questionVersionId: item.questionVersionId,
          points: item.points,
          milestone: item.milestone,
        })),
      );
    }
  });
  return (await byId(db, id))!;
}
