/** The reads of the `evaluation` module: views, items, rosters, lists. */
import { and, asc, count, desc, eq, inArray, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  DEFAULT_MCQ_POLICY,
  categorizePolicyOf,
  type ConceptLang,
  type ConceptRef,
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
  retakesOf,
  type RetakeSettings,
} from "@quiz/contracts";
import {
  type CourseRoleName,
  evaluationDeletionRole,
  evaluationHoldsStudentWork,
  type EvaluationWorkFacts,
  isConfigEditable,
  poolRoleAllows,
  negativeMarkingOn,
  retakesOn,
  round2,
  trustedClientsOf,
  type TrustedClient,
  drillAllowedOn,
  afterDueOpen,
  practicePrintable,
  effectiveFeedbackPolicy,
  evaluationTotal,
  practiceRefusal,
  type MaskedPerson,
  clockChoiceOf,
} from "@quiz/domain";

import { iso, isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import {
  attempts,
  classrooms,
  courseHasComponents,
  courses,
  enrollments,
  evaluationItems,
  evaluations,
  excusedMarkOfSeat,
  gradebookColumns,
  gradebookComponents,
  gradebookMarks,
  isStaffAttempt,
  officialAttempt,
  pools,
  scoreMarksOf,
  questionVersions,
  questions,
  users,
} from "../../db/schema.js";
import { first } from "../../db/query.js";
import { conceptsOf } from "../concept/service.js";
import { poolRolesOf } from "../pool/service.js";
import { exportsOf, printRefusal } from "./print.js";
import { providedDocumentsOf } from "./providedDocuments.js";
import type { EvaluationHome, EvaluationRecord, ItemRecord, DbOrTx } from "./shared.js";
import type { Caller } from "../guards.js";

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
export const isLatestAttempt = sql`not ${attempts.afterDue} and not exists (select 1 from ${attempts} as later where later.evaluation_id = ${attempts.evaluationId} and later.user_id = ${attempts.userId} and later.attempt_number > ${attempts.attemptNumber} and not later.after_due)`;

/**
 * The feedback policy the teacher stored: what the editor shows and writes,
 * and what a template or a copy carries. Never what a student reads under —
 * that is {@link feedbackOf}.
 */
export function storedFeedbackOf(row: EvaluationRecord): FeedbackPolicy {
  return FeedbackPolicy.parse(row.feedbackPolicy);
}

/**
 * The feedback policy a student reads under (`effectiveFeedbackPolicy`,
 * ADR-124): an exercise's whole correction at the hand-in, whatever is
 * stored; an exam's and a poll's stored policy.
 */
export function feedbackOf(row: EvaluationRecord): FeedbackPolicy {
  return effectiveFeedbackPolicy(row.mode, storedFeedbackOf(row));
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
    allowDrill: drillAllowed(row),
    afterDueOpen: practiceOpen(row),
    gradingScale: GradingScale.parse(row.gradingScale),
    feedbackPolicy: storedFeedbackOf(row),
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
    contestationClosesAt: isoOrNull(row.contestationClosesAt),
    correctionPublishedAt: isoOrNull(row.correctionPublishedAt),
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

/** ADR-041 §2: its questions become drill cards (the classroom's switch aside). */
export function drillAllowed(row: EvaluationRecord): boolean {
  return drillAllowedOn(row.mode, settingsOf(row).allowDrill);
}

/**
 * ADR-122, ADR-142: whether this evaluation takes practice attempts once it
 * is over — the teacher's switch or its default, and for an exam its stored
 * feedback policy (`afterDueOpen`, the one rule).
 */
export function practiceOpen(row: EvaluationRecord): boolean {
  const settings = settingsOf(row);
  return afterDueOpen({
    mode: row.mode,
    afterDue: settings.afterDue,
    safeExamBrowser: settings.safeExamBrowser,
    kiosk: settings.kiosk,
    feedback: storedFeedbackOf(row),
  });
}

/**
 * ADR-122 §9, "Past series": whether this evaluation is one of them for a
 * student of its classroom (`archivedAt`, the classroom's) — an exercise
 * that is over, or an exam released (ADR-142), that takes practice
 * attempts, in a classroom not archived; an exam only for a student who
 * handed it in (`taken`, a finished official attempt of theirs). The one
 * rule the home's list and the series' blank print (ADR-112 amendment of
 * 2026-11-03) read: the practice rule (`practiceRefusal`) before the
 * student's unfinished attempts count.
 */
export function inPastSeries(row: EvaluationRecord, archivedAt: Date | null, taken: boolean): boolean {
  return (
    practiceRefusal({
      mode: row.mode,
      open: practiceOpen(row),
      evaluationState: row.state,
      archived: archivedAt !== null,
      taken,
      unfinishedOfficial: false,
    }) === null
  );
}

/**
 * ADR-142 §5: whether this evaluation's blank print is offered as a past
 * series (`practicePrintable`: an exercise's, never an exam's), the series
 * being in its classroom's past series. A printing mode never asks who took
 * it (`needsTaken`, asserted by the domain's tests), so no student's attempt
 * is read. The one rule of the home's printer and the hand-out route.
 */
export function pastSeriesPrintable(row: EvaluationRecord, archivedAt: Date | null): boolean {
  return practicePrintable(row.mode) && inPastSeries(row, archivedAt, false);
}

/**
 * ADR-027, ADR-051 §2: the trusted clients this evaluation is sat through —
 * empty for the portal. Exam switches; inert on any other mode.
 */
export function trustedClients(row: EvaluationRecord): TrustedClient[] {
  return trustedClientsOf(row.mode, settingsOf(row));
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

/** The attempts of anyone but a staff seat (ADR-018): a student's, or a poll guest's. */
const isStudentAttempt = sql`not ${isStaffAttempt}`;

/**
 * The role deleting this evaluation needs (`evaluationDeletionRole`, ADR-068
 * §3 amended 2026-10-10), from the row as given — inside the delete's
 * transaction, the row it locked.
 */
export async function deletionRole(db: DbOrTx, row: EvaluationRecord): Promise<CourseRoleName> {
  return deletionRoleOf(row, (await attemptCounts(db, row.id)).students);
}

/**
 * A student's attempt that holds work (ADR-141): started, submitted, or a
 * paper copy — which the teacher enters submitted, never started
 * (`insertPaperAttempt`). The work a deletion would erase.
 */
const isWorkAttempt = sql`(${attempts.startedAt} is not null or ${attempts.submittedAt} is not null or ${attempts.origin} = 'paper') and ${isStudentAttempt}`;

/** Every attempt row of the evaluation, those of a student seat (or a poll guest), and those holding work. */
async function attemptCounts(
  db: DbOrTx,
  evaluationId: string,
): Promise<{ all: number; students: number; withWork: number }> {
  const [row] = await db
    .select({
      all: count(),
      students: sql<number>`count(*) filter (where ${isStudentAttempt})`.mapWith(Number),
      withWork: sql<number>`count(*) filter (where ${isWorkAttempt})`.mapWith(Number),
    })
    .from(attempts)
    .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
    .where(eq(attempts.evaluationId, evaluationId));
  return { all: row?.all ?? 0, students: row?.students ?? 0, withWork: row?.withWork ?? 0 };
}

const deletionRoleOf = (row: EvaluationRecord, studentAttempts: number): CourseRoleName =>
  evaluationDeletionRole({
    mode: row.mode,
    released: row.releasedAt !== null,
    correctionPublished: row.correctionPublishedAt !== null,
    studentAttempts,
  });

const holdsWorkOf = (row: EvaluationRecord, attemptsWithWork: number, scoreMarks: number): boolean =>
  evaluationHoldsStudentWork({ mode: row.mode, released: row.releasedAt !== null, attemptsWithWork, scoreMarks });

/** Where a deletion reaches evaluations (ADR-141): one, a classroom's, or a course's classrooms'. */
export type WorkScope = { evaluationId: string } | { classroomId: string } | { courseId: string };

/**
 * The facts `studentWorkOf` judges (ADR-141), for the evaluations of
 * `scope` — a course's templates left out, which hold no attempt. Inside a
 * delete's transaction, what could add work meanwhile waits for the delete
 * and then finds the evaluation gone:
 *   - the evaluations are locked `FOR UPDATE`: a new attempt, a paper copy
 *     or a new gradebook column (their foreign keys take `FOR KEY SHARE`),
 *     and a release;
 *   - their attempts `FOR SHARE`: an attempt's start or hand-in (an UPDATE);
 *   - their gradebook columns `FOR UPDATE` (`scoreMarksOf`): a mark.
 * Outside one, a plain read.
 */
export async function evaluationWork(db: DbOrTx, scope: WorkScope): Promise<EvaluationWorkFacts[]> {
  const where =
    "evaluationId" in scope
      ? eq(evaluations.id, scope.evaluationId)
      : "classroomId" in scope
        ? eq(evaluations.classroomId, scope.classroomId)
        : inArray(
            evaluations.classroomId,
            db.select({ id: classrooms.id }).from(classrooms).where(eq(classrooms.courseId, scope.courseId)),
          );
  const rows = await db
    .select({ id: evaluations.id, classroomId: evaluations.classroomId, mode: evaluations.mode, releasedAt: evaluations.releasedAt })
    .from(evaluations)
    .where(where)
    .for("update");
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  await db.select({ id: attempts.id }).from(attempts).where(inArray(attempts.evaluationId, ids)).for("share");
  const held = await db
    .select({ id: attempts.evaluationId, n: count() })
    .from(attempts)
    .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
    .where(and(inArray(attempts.evaluationId, ids), isWorkAttempt))
    .groupBy(attempts.evaluationId);
  const heldOf = new Map(held.map((s) => [s.id, s.n]));
  const marks = await scoreMarksOf(db, "evaluationId", ids, { lock: true });
  return rows.map((r) => ({
    classroomId: r.classroomId,
    mode: r.mode,
    released: r.releasedAt !== null,
    attemptsWithWork: heldOf.get(r.id) ?? 0,
    scoreMarks: marks.get(r.id) ?? 0,
  }));
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

/**
 * The items whose frozen version declares variables (ADR-056): what a new
 * attempt draws values for. Usually none, and then nothing else is read.
 */
export async function parameterizedItems(db: DbOrTx, evaluationId: string): Promise<JoinedItem[]> {
  return selectJoinedItems(db).where(
    and(eq(evaluationItems.evaluationId, evaluationId), isNotNull(questionVersions.variables)),
  );
}

/** One item of one evaluation, by primary key — not the whole list filtered. */
export async function joinedItem(
  db: DbOrTx,
  evaluationId: string,
  itemId: string,
): Promise<JoinedItem | null> {
  return first(selectJoinedItems(db)
    .where(and(eq(evaluationItems.id, itemId), eq(evaluationItems.evaluationId, evaluationId))));
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
 *
 * `classroomId` narrows it to one of those classrooms (the student's
 * classroom page, M5-01): the same rows, never a second query shape.
 * `staff`: the seat is a staff seat (ADR-018), which the Grades page lists
 * only once it holds an attempt. `storedCounts`: the teacher's `counts` of the
 * evaluation's gradebook column, null where none is stored (read by join, the
 * table is the gradebook's; at most one per evaluation,
 * `gradebook_columns_evaluation_uq`), for the Grades page's groups (#803).
 * `excusedMarkId`: the seat's `excused` gradebook mark on that column, null
 * without one (#969) — its id alone, never its staff-only comment.
 * `componentId`, `componentName`: the column's component of the mean, null
 * without one, and `courseHasComponents` whether the course has any — what
 * `countsInMean` reads (ADR-131); never a component's weight.
 */
export function studentEvaluationRows(db: Db, userId: string, classroomId?: string) {
  return db
    .select({
      evaluation: evaluations,
      classroomName: classrooms.name,
      courseCode: courses.code,
      // The Grades page's group header (F-ORG-14), archived classrooms included.
      courseName: courses.name,
      period: classrooms.period,
      archivedAt: classrooms.archivedAt,
      staff: enrollments.staff,
      // The seat's extra time, in the conditions of a trusted-client card (ADR-079 §7).
      timeBonusPercent: enrollments.timeBonusPercent,
      attempt: attempts,
      storedCounts: gradebookColumns.counts,
      excusedMarkId: gradebookMarks.id,
      componentId: gradebookColumns.componentId,
      componentName: gradebookComponents.name,
      courseHasComponents: courseHasComponents(courses.id),
    })
    .from(enrollments)
    .innerJoin(classrooms, eq(enrollments.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .innerJoin(evaluations, eq(evaluations.classroomId, classrooms.id))
    .leftJoin(
      attempts,
      and(eq(attempts.evaluationId, evaluations.id), eq(attempts.userId, userId), isLatestAttempt),
    )
    .leftJoin(gradebookColumns, eq(gradebookColumns.evaluationId, evaluations.id))
    .leftJoin(gradebookMarks, excusedMarkOfSeat())
    .leftJoin(gradebookComponents, eq(gradebookComponents.id, gradebookColumns.componentId))
    .where(
      and(
        eq(enrollments.userId, userId),
        classroomId === undefined ? undefined : eq(enrollments.classroomId, classroomId),
      ),
    );
}

/**
 * The exams and exercises of a classroom, whatever their state: those that
 * may have a gradebook column — a poll never has one. With a course instead,
 * its templates (ADR-131 §15): the rows whose `course_id` is set are exactly
 * those (`evaluations_home_ck`), drafts forever, so never listed.
 */
const withColumn = (home: EvaluationHome): SQL =>
  and(
    "classroomId" in home ? eq(evaluations.classroomId, home.classroomId) : eq(evaluations.courseId, home.courseId),
    inArray(evaluations.mode, ["exam", "exercise"]),
  )!;

/** Whether the gradebook lists such an evaluation's column ({@link gradebookEvaluations}): no draft. */
const listedColumn = (): SQL => ne(evaluations.state, "draft");

/**
 * The evaluations of a classroom the gradebook has a column for (F-GBOOK-01,
 * D06): exams and exercises that are no draft — a poll never has one. The
 * caller has loaded the classroom (`staffAccess` or `readableClassroom`).
 */
export function gradebookEvaluations(db: Db, classroomId: string): Promise<EvaluationRecord[]> {
  return db
    .select()
    .from(evaluations)
    .where(and(withColumn({ classroomId }), listedColumn()));
}

/**
 * An exam or exercise of the classroom, whatever its state, draft included —
 * or a template of the course (ADR-131 §15): one whose gradebook column's
 * settings may be written and read (ADR-131 §13), and whether
 * {@link gradebookEvaluations} lists its column yet (never a template's).
 * Undefined for a poll, another classroom's or course's, a missing one. The
 * caller has loaded the classroom or the template through `staffAccess`.
 */
export async function columnEvaluation(
  db: Db,
  home: EvaluationHome,
  evaluationId: string,
): Promise<{ evaluation: EvaluationRecord; listed: boolean } | undefined> {
  const [row] = await db
    .select({ evaluation: evaluations, listed: sql<boolean>`(${listedColumn()})` })
    .from(evaluations)
    .where(and(withColumn(home), eq(evaluations.id, evaluationId)));
  return row;
}

/**
 * The total points of each evaluation, in one grouped query:
 * `@quiz/domain#evaluationTotal` in SQL, bonus and neutralized items left out
 * (ADR-052, ADR-108).
 */
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
    .where(
      and(
        inArray(evaluationItems.evaluationId, [...evaluationIds]),
        eq(evaluationItems.counting, "normal"),
      ),
    )
    .groupBy(evaluationItems.evaluationId);
  return new Map(rows.map((r) => [r.evaluationId, round2(Number(r.points))]));
}

/**
 * Which of `list` print a hand-out (ADR-125 §5), in one query: the ids
 * `printRefusal` lets through, so a screen never offers a print the route
 * refuses.
 */
export async function handoutPrints(
  db: Db,
  list: readonly { id: string; mode: string }[],
): Promise<Set<string>> {
  if (list.length === 0) return new Set();
  const rows = await db
    .select({ evaluationId: evaluationItems.evaluationId, type: questions.type })
    .from(evaluationItems)
    .innerJoin(questionVersions, eq(evaluationItems.questionVersionId, questionVersions.id))
    .innerJoin(questions, eq(questionVersions.questionId, questions.id))
    .where(inArray(evaluationItems.evaluationId, list.map((e) => e.id)));
  type Printed = Parameters<typeof printRefusal>[1][number];
  const itemsOf = new Map<string, Printed[]>();
  for (const r of rows) {
    const items = itemsOf.get(r.evaluationId) ?? [];
    items.push({ question: { type: r.type } });
    itemsOf.set(r.evaluationId, items);
  }
  const prints = list.filter((evaluation) => printRefusal(evaluation, itemsOf.get(evaluation.id) ?? [], "handout") === null);
  return new Set(prints.map((e) => e.id));
}

/** How many items each evaluation holds, in one grouped query. */
export async function itemCountsByEvaluation(
  db: Db,
  evaluationIds: readonly string[],
): Promise<Map<string, number>> {
  return itemCountsWhere(db, evaluationIds);
}

/**
 * How many items of each evaluation count for the student
 * (`@quiz/domain#countsForStudent` in SQL, ADR-108): the cells a student's
 * score still waits for (`scoreOf`), a neutralized item left out.
 */
export async function countedItemsByEvaluation(
  db: Db,
  evaluationIds: readonly string[],
): Promise<Map<string, number>> {
  return itemCountsWhere(db, evaluationIds, COUNTS_FOR_STUDENT);
}

/** `countsForStudent` on a query with `evaluation_items` in scope. */
export const COUNTS_FOR_STUDENT = ne(evaluationItems.counting, "neutralized");

async function itemCountsWhere(
  db: Db,
  evaluationIds: readonly string[],
  where?: SQL,
): Promise<Map<string, number>> {
  if (evaluationIds.length === 0) return new Map();
  const rows = await db
    .select({ evaluationId: evaluationItems.evaluationId, n: count() })
    .from(evaluationItems)
    .where(and(inArray(evaluationItems.evaluationId, [...evaluationIds]), where))
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
    counting: j.item.counting,
    intro: j.item.intro,
    introScope: j.item.introScope,
    questionId: j.question.id,
    questionVersionId: j.version.id,
    type: j.question.type,
    internalName: j.question.internalName,
    versionNumber: j.version.number ?? 0,
    latestVersionNumber: latest.get(j.question.id) ?? null,
    deprecated: j.version.deprecatedAt !== null,
    difficulty: j.question.difficulty,
  }));
}

/** The concepts of the items' questions, by question id, labelled in `lang`. */
export async function itemConcepts(
  db: DbOrTx,
  rows: readonly ItemRow[],
  lang: ConceptLang,
): Promise<Record<string, ConceptRef[]>> {
  const refs = await conceptsOf(db, [...new Set(rows.map((r) => r.questionId))], lang);
  return Object.fromEntries(refs);
}

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
    .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
    .where(and(eq(attempts.evaluationId, evaluation.id), isStaffAttempt));
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
    .where(and(eq(attempts.evaluationId, row.id), eq(attempts.userId, userId), officialAttempt))
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
 * resolution (`poolRolesOf`), so this cannot drift from what the editor then
 * allows. A pool the viewer does not reach at all resolves to `reader`, and
 * its questions are simply not in the list.
 */
export async function editableQuestionIdsOf(
  db: Db,
  items: readonly ItemRow[],
  viewer: Caller,
): Promise<string[]> {
  if (items.length === 0) return [];
  const rows = await db
    .select({ id: questions.id, poolId: questions.poolId })
    .from(questions)
    .where(inArray(questions.id, [...new Set(items.map((i) => i.questionId))]));
  const poolIds = [...new Set(rows.flatMap((r) => (r.poolId === null ? [] : [r.poolId])))];
  if (poolIds.length === 0) return [];
  const roles = await poolRolesOf(db, inArray(pools.id, poolIds), viewer);
  const writable = new Set(
    [...roles].filter(([, { role }]) => poolRoleAllows(role, "contributor")).map(([id]) => id),
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
  viewer: Caller,
  enrolled: number,
  courseId: string,
  lang: ConceptLang,
): Promise<EvaluationDetail> {
  const joined = await joinedItems(db, row.id);
  const items = await itemRowsOf(db, joined);
  const counted = await attemptCounts(db, row.id);
  const attemptsSoFar = counted.all;
  return {
    evaluation: toEvaluation(row),
    items,
    concepts: await itemConcepts(db, items, lang),
    totalPoints: evaluationTotal(items),
    staleItems: staleOf(items),
    attemptCount: attemptsSoFar,
    deletionRole: deletionRoleOf(row, counted.students),
    holdsStudentWork: holdsWorkOf(row, counted.withWork, (await scoreMarksOf(db, "evaluationId", [row.id], { lock: false })).get(row.id) ?? 0),
    editable: isConfigEditable(row.state, attemptsSoFar),
    self: await selfOf(db, row, viewer.id),
    editableQuestionIds: await editableQuestionIdsOf(db, items, viewer),
    roster: await rosterOf(db, row, enrolled),
    templateRevision: (await templateRevisionsOf(db, [row])).get(row.id) ?? null,
    courseId,
    exports: exportsOf(row, joined),
    documents: await providedDocumentsOf(db, row.id),
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
  // The same total as everywhere else, bonus items left out (ADR-052).
  const [itemCounts, totals] = await Promise.all([
    itemCountsByEvaluation(db, ids),
    totalPointsByEvaluation(db, ids),
  ]);
  // Students, not attempt rows: a retake (F-EVAL-15) is not a second student.
  // The staff's rehearsals are counted apart for the deletion's role (ADR-068 §3)
  // and left out of the list's Participants (ADR-018), which a guest joins.
  const attemptStats = await db
    .select({
      evaluationId: attempts.evaluationId,
      // A practice attempt after the due date (ADR-122) is not a participant;
      // it is a student's data, which the deletion's role still counts.
      n: sql<number>`count(distinct coalesce(${attempts.userId}, ${attempts.guestId})) filter (where ${officialAttempt})`.mapWith(Number),
      participants: sql<number>`count(distinct coalesce(${attempts.userId}, ${attempts.guestId})) filter (where ${isStudentAttempt} and ${officialAttempt})`.mapWith(Number),
      students: sql<number>`count(*) filter (where ${isStudentAttempt})`.mapWith(Number),
      withWork: sql<number>`count(*) filter (where ${isWorkAttempt})`.mapWith(Number),
    })
    .from(attempts)
    .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
    .where(inArray(attempts.evaluationId, ids))
    .groupBy(attempts.evaluationId);
  const tries = new Map(attemptStats.map((s) => [s.evaluationId, s]));
  const templateRevisions = await templateRevisionsOf(db, rows);
  const marks = await scoreMarksOf(db, "evaluationId", ids, { lock: false });
  return rows.map((r) => ({
    id: r.id,
    classroomId,
    title: r.title,
    mode: r.mode,
    state: r.state,
    itemCount: itemCounts.get(r.id) ?? 0,
    totalPoints: totals.get(r.id) ?? 0,
    attemptCount: tries.get(r.id)?.n ?? 0,
    participantCount: tries.get(r.id)?.participants ?? 0,
    deletionRole: deletionRoleOf(r, tries.get(r.id)?.students ?? 0),
    holdsStudentWork: holdsWorkOf(r, tries.get(r.id)?.withWork ?? 0, marks.get(r.id) ?? 0),
    clock: clockChoiceOf(settingsOf(r)).mode,
    opensAt: isoOrNull(r.opensAt),
    closesAt: isoOrNull(r.closesAt),
    startedAt: isoOrNull(r.startedAt),
    createdAt: iso(r.createdAt),
    originRevision: r.originRevision,
    templateRevision: templateRevisions.get(r.id) ?? null,
  }));
}

export async function byId(db: DbOrTx, id: string): Promise<EvaluationRecord | null> {
  return first(db.select().from(evaluations).where(eq(evaluations.id, id)));
}

/**
 * Whom a text of this evaluation must not name before it leaves for a model
 * (N-DATA-05): whoever sat it with an account, and the classroom's roster. A
 * classroom-less poll has no roster; its guests are nobody the platform knows.
 */
export async function peopleOf(db: Db, evaluation: EvaluationRecord): Promise<MaskedPerson[]> {
  const sat = await db
    .select({ givenName: users.givenName, familyName: users.familyName, email: users.email })
    .from(attempts)
    .innerJoin(users, eq(attempts.userId, users.id))
    .where(eq(attempts.evaluationId, evaluation.id));
  if (evaluation.classroomId === null) return sat;
  const roster = await db
    .select({ givenName: enrollments.prenom, familyName: enrollments.nom, email: enrollments.email })
    .from(enrollments)
    .where(eq(enrollments.classroomId, evaluation.classroomId));
  return [...sat, ...roster];
}

/**
 * Whether the evaluation's classroom is archived: it takes no student write
 * — a practice attempt (ADR-122 §1), a contestation (ADR-139). An evaluation
 * with no classroom (an anonymous poll) never is.
 */
export async function classroomArchived(db: DbOrTx, evaluation: Pick<EvaluationRecord, "classroomId">): Promise<boolean> {
  if (evaluation.classroomId === null) return false;
  const [row] = await db
    .select({ archivedAt: classrooms.archivedAt })
    .from(classrooms)
    .where(eq(classrooms.id, evaluation.classroomId))
    .limit(1);
  return row?.archivedAt != null;
}
