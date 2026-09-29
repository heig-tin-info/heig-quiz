/** The reads of the `evaluation` module: views, items, rosters, lists. */
import { and, asc, count, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  DEFAULT_MCQ_POLICY,
  categorizePolicyOf,
  EvaluationSettings,
  FeedbackPolicy,
  GradingScale,
  type Evaluation,
  type EvaluationDetail,
  type EvaluationSelf,
  type EvaluationSummary,
  type ItemRow,
  type McqPolicy,
  negativeMarkingOf,
  safeExamBrowserOf,
  retakesOf,
  type RetakeSettings,
} from "@quiz/contracts";
import {
  isConfigEditable,
  poolRoleAllows,
  negativeMarkingOn,
  retakesOn,
  round2,
  safeExamBrowserOn,
} from "@quiz/domain";

import { iso, isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import {
  attempts,
  classrooms,
  courses,
  enrollments,
  evaluationItems,
  evaluations,
  pools,
  questionVersions,
  questions,
  users,
} from "../../db/schema.js";
import { listPools } from "../pool/service.js";
import type { EvaluationRecord, ItemRecord, DbOrTx } from "./shared.js";

/**
 * The roster seats of an evaluation, as a condition on `enrollments`: the
 * seats of its classroom. An anonymous poll (ADR-014, addendum 2026-09-27)
 * and a template (ADR-031) belong to no classroom and have no roster, so for
 * them the condition matches no seat — never "every seat whose classroom is
 * null".
 */
export function seatsOf(row: Pick<EvaluationRecord, "classroomId">): SQL {
  return row.classroomId === null ? sql`false` : eq(enrollments.classroomId, row.classroomId);
}

/**
 * The classroom of an evaluation that was reached THROUGH its classroom (a
 * join, a listing by classroom): it has one, and only an anonymous poll or a
 * template could lack it — which no such path returns.
 */
export function classroomIdOf(row: Pick<EvaluationRecord, "id" | "classroomId">): string {
  if (row.classroomId === null) throw new Error(`evaluation ${row.id} has no classroom`);
  return row.classroomId;
}

export function settingsOf(row: EvaluationRecord): EvaluationSettings {
  return EvaluationSettings.parse(row.settings);
}

/** F-EVAL-15: the retake rule of an evaluation, one attempt when it never set one. */
export function retakePolicyOf(row: EvaluationRecord): RetakeSettings {
  return retakesOf(settingsOf(row));
}

/** F-EVAL-15: the evaluation lets a student take several attempts. */
export function retakesEnabled(row: EvaluationRecord): boolean {
  return retakesOn(row.mode, retakePolicyOf(row));
}

/**
 * The student's CURRENT attempt among several (F-EVAL-15, ADR-025): no other
 * attempt of the same student on the same evaluation has a higher number. A
 * predicate on the row `attempts`, for the joins that must see ONE row per
 * student; a guest (`user_id` null) holds one attempt and always passes.
 * Only in a SELECT, where drizzle qualifies the outer columns by table name.
 */
export const isLatestAttempt = sql`not exists (select 1 from ${attempts} as later where later.evaluation_id = ${attempts.evaluationId} and later.user_id = ${attempts.userId} and later.attempt_number > ${attempts.attemptNumber})`;

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
    classroomId: classroomIdOf(row),
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
    originRevision: row.originRevision,
  };
}

const originTemplate = alias(evaluations, "origin_template");

/**
 * The CURRENT revision of each evaluation's template (F-EVAL-26), in one
 * query: absent from the map when the evaluation has no origin, or when its
 * template is gone — or belongs to another course than the evaluation's
 * classroom: for an instance, a template of another course is no template at
 * all (ADR-031, invariant 6 in depth). The pull reads a template by the
 * same rule, locked, in `originTemplate` (`templates.ts`): a change to the
 * same-course rule changes both.
 */
export async function templateRevisionsOf(
  db: DbOrTx,
  rows: readonly EvaluationRecord[],
): Promise<Map<string, number>> {
  const ids = rows.filter((r) => r.originTemplateId !== null).map((r) => r.id);
  if (ids.length === 0) return new Map();
  const found = await db
    .select({ id: evaluations.id, revision: originTemplate.revision })
    .from(evaluations)
    .innerJoin(classrooms, eq(classrooms.id, evaluations.classroomId))
    .innerJoin(
      originTemplate,
      and(
        eq(originTemplate.id, evaluations.originTemplateId),
        eq(originTemplate.courseId, classrooms.courseId),
      ),
    )
    .where(inArray(evaluations.id, ids));
  return new Map(found.flatMap((r) => (r.revision === null ? [] : [[r.id, r.revision] as const])));
}

/**
 * The per-type settings of this evaluation, as `GradeContext.defaults` — what
 * a question config that says "inherit" defers to (invariant: the core knows
 * no type's shape, each type parses its own entry).
 *
 * Two entries, `mcq` and `categorize` (ADR-036); a type with an
 * evaluation-level setting adds its key here and nowhere else. Negative
 * marking travels in both: it is one rule of the evaluation for every choice
 * question.
 */
export function gradeDefaults(row: EvaluationRecord): Readonly<Record<string, unknown>> {
  const negativeMarking = negativeMarkingEnabled(row);
  return {
    mcq: { policy: row.mcqPolicy, negativeMarking },
    categorize: { policy: categorizePolicyOf(settingsOf(row)), negativeMarking },
  };
}

/**
 * ADR-026: the evaluation scores its choice questions (`mcq`, and
 * `categorize` since ADR-036) with negative marking.
 * Read here and nowhere else — the grader through {@link gradeDefaults}, the
 * student's question through the same defaults, the waiting room, and the
 * range of a manual correction — and never on a poll, whatever its row says.
 */
export function negativeMarkingEnabled(row: EvaluationRecord): boolean {
  return negativeMarkingOn(row.mode, negativeMarkingOf(settingsOf(row)));
}

/** ADR-027: sat in Safe Exam Browser only. An exam's switch; inert on any other mode. */
export function sebRequired(row: EvaluationRecord): boolean {
  return safeExamBrowserOn(row.mode, safeExamBrowserOf(settingsOf(row)));
}

/**
 * The MCQ policy a NEW evaluation of this teacher starts with. A user who
 * never opened the settings page has none, and the default is the one nobody
 * has to be told about.
 */
export async function preferredMcqPolicy(db: Db, userId: string): Promise<McqPolicy> {
  const [row] = await db
    .select({ policy: users.mcqPolicy })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.policy ?? DEFAULT_MCQ_POLICY;
}

export async function attemptCount(db: DbOrTx, evaluationId: string): Promise<number> {
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

const selectJoinedItems = (db: DbOrTx) =>
  db
    .select({ item: evaluationItems, version: questionVersions, question: questions })
    .from(evaluationItems)
    .innerJoin(questionVersions, eq(evaluationItems.questionVersionId, questionVersions.id))
    .innerJoin(questions, eq(questionVersions.questionId, questions.id));

export async function joinedItems(db: DbOrTx, evaluationId: string): Promise<JoinedItem[]> {
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
 *
 * The attempt is the LATEST one (F-EVAL-15): one row per evaluation, however
 * many retakes. The attempt that COUNTS is the grading module's
 * `studentAttempts` to say.
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
      and(eq(attempts.evaluationId, evaluations.id), eq(attempts.userId, userId), isLatestAttempt),
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

/** How many items each evaluation holds, in one grouped query. */
export async function itemCountsByEvaluation(
  db: Db,
  evaluationIds: readonly string[],
): Promise<Map<string, number>> {
  if (evaluationIds.length === 0) return new Map();
  const rows = await db
    .select({ evaluationId: evaluationItems.evaluationId, n: count() })
    .from(evaluationItems)
    .where(inArray(evaluationItems.evaluationId, [...evaluationIds]))
    .groupBy(evaluationItems.evaluationId);
  return new Map(rows.map((r) => [r.evaluationId, r.n]));
}

/** The highest published version number of each question, in one query. */
async function latestNumbers(db: DbOrTx, questionIds: string[]): Promise<Map<string, number>> {
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

export async function itemRows(db: DbOrTx, evaluationId: string): Promise<ItemRow[]> {
  return itemRowsOf(db, await joinedItems(db, evaluationId));
}

/** `itemRows` for a caller that already holds the joined items. */
export async function itemRowsOf(db: DbOrTx, joined: readonly JoinedItem[]): Promise<ItemRow[]> {
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
        seatsOf(evaluation),
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
  {
    seatId: string;
    userId: string;
    nom: string;
    prenom: string;
    email: string;
    timeBonusPercent: number;
  }[]
> {
  return db
    .select({
      seatId: enrollments.id,
      userId: sql<string>`${enrollments.userId}`,
      nom: enrollments.nom,
      prenom: enrollments.prenom,
      email: enrollments.email,
      timeBonusPercent: enrollments.timeBonusPercent,
    })
    .from(enrollments)
    .innerJoin(
      attempts,
      // One row per seat, however many attempts the teacher took (F-EVAL-15).
      and(
        eq(attempts.userId, enrollments.userId),
        eq(attempts.evaluationId, evaluation.id),
        isLatestAttempt,
      ),
    )
    .where(
      and(seatsOf(evaluation), eq(enrollments.staff, true)),
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
        seatsOf(row),
        eq(enrollments.userId, userId),
      ),
    )
    .limit(1);
  const [attempt] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(and(eq(attempts.evaluationId, row.id), eq(attempts.userId, userId)))
    .orderBy(desc(attempts.attemptNumber))
    .limit(1);
  return {
    seat: seat !== undefined,
    staffSeat: seat?.staff ?? false,
    attemptId: attempt?.id ?? null,
  };
}

/**
 * The questions of this evaluation the viewer may open in the editor (issue
 * #127): those whose pool they hold at least `contributor` in — the role
 * every write route of a question asks for. The role is the pool list's own
 * resolution (`listPools`), so this cannot drift from what the editor then
 * allows. A pool the viewer does not reach at all resolves to `reader`, and
 * its questions are simply not in the list.
 */
export async function editableQuestionIdsOf(
  db: Db,
  items: readonly ItemRow[],
  viewer: { id: string; role: string },
): Promise<string[]> {
  if (items.length === 0) return [];
  const rows = await db
    .select({ id: questions.id, poolId: questions.poolId })
    .from(questions)
    .where(inArray(questions.id, [...new Set(items.map((i) => i.questionId))]));
  const poolIds = [...new Set(rows.flatMap((r) => (r.poolId === null ? [] : [r.poolId])))];
  if (poolIds.length === 0) return [];
  const writable = new Set(
    (await listPools(db, inArray(pools.id, poolIds), viewer))
      .filter((p) => poolRoleAllows(p.role, "contributor"))
      .map((p) => p.id),
  );
  return rows.filter((r) => r.poolId !== null && writable.has(r.poolId)).map((r) => r.id);
}

/**
 * The roster half of the launch checklist (#152): the class seats still
 * without an account, and those the import flagged. Staff seats are never
 * counted, like the class headcount. `enrolled` comes from the caller, because it
 * is the lobby ring's denominator and that rule lives in the `live` module.
 */
async function rosterOf(
  db: Db,
  row: EvaluationRecord,
  enrolled: number,
): Promise<EvaluationDetail["roster"]> {
  if (row.classroomId === null) return null;
  const [counts] = await db
    .select({
      unlinked: sql<number>`count(*) filter (where ${enrollments.userId} is null)`.mapWith(Number),
      conflicts: sql<number>`count(*) filter (where ${enrollments.conflictFlag})`.mapWith(Number),
    })
    .from(enrollments)
    .where(and(seatsOf(row), eq(enrollments.staff, false)));
  return {
    enrolled,
    unlinked: counts?.unlinked ?? 0,
    conflicts: counts?.conflicts ?? 0,
  };
}

export async function evaluationDetail(
  db: Db,
  row: EvaluationRecord,
  viewer: { id: string; role: string },
  enrolled: number,
): Promise<EvaluationDetail> {
  const items = await itemRows(db, row.id);
  const attemptsSoFar = await attemptCount(db, row.id);
  return {
    evaluation: toEvaluation(row),
    items,
    totalPoints: totalPointsOf(items),
    staleItems: staleOf(items),
    attemptCount: attemptsSoFar,
    editable: isConfigEditable(row.state, attemptsSoFar),
    self: await selfOf(db, row, viewer.id),
    editableQuestionIds: await editableQuestionIdsOf(db, items, viewer),
    roster: await rosterOf(db, row, enrolled),
    templateRevision: (await templateRevisionsOf(db, [row])).get(row.id) ?? null,
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
  // Students, not attempt rows: a retake (F-EVAL-15) is not a second student.
  const attemptStats = await db
    .select({
      evaluationId: attempts.evaluationId,
      n: sql<number>`count(distinct coalesce(${attempts.userId}, ${attempts.guestId}))`.mapWith(Number),
    })
    .from(attempts)
    .where(inArray(attempts.evaluationId, ids))
    .groupBy(attempts.evaluationId);
  const items = new Map(itemStats.map((s) => [s.evaluationId, s]));
  const tries = new Map(attemptStats.map((s) => [s.evaluationId, s.n]));
  const templateRevisions = await templateRevisionsOf(db, rows);
  return rows.map((r) => ({
    id: r.id,
    classroomId,
    title: r.title,
    mode: r.mode,
    state: r.state,
    itemCount: items.get(r.id)?.n ?? 0,
    totalPoints: Number(items.get(r.id)?.points ?? 0),
    attemptCount: tries.get(r.id) ?? 0,
    opensAt: isoOrNull(r.opensAt),
    closesAt: isoOrNull(r.closesAt),
    createdAt: iso(r.createdAt),
    originRevision: r.originRevision,
    templateRevision: templateRevisions.get(r.id) ?? null,
  }));
}

export async function byId(db: DbOrTx, id: string): Promise<EvaluationRecord | null> {
  const [row] = await db.select().from(evaluations).where(eq(evaluations.id, id)).limit(1);
  return row ?? null;
}
