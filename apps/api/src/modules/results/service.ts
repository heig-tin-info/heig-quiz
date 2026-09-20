/**
 * The `results` module's business layer (PLAN-MVP §4.6, §7.1).
 *
 * Three things live here and nowhere else:
 *
 *   - the GRADE. It is never computed in a route: points come from the
 *     validated gradings, the scale from `evaluations.grading_scale`, and the
 *     conversion from `@quiz/domain#gradeFromPoints` (§10);
 *   - the RELEASE. One transaction writes the frozen snapshot
 *     (`released_grades`) and `released_at` together, so a half-released
 *     evaluation cannot exist (ADR-012's property, F-RES-04);
 *   - the FEEDBACK POLICY. {@link studentFeedback} is the only place it is
 *     applied, and it is the second half of the content gate of docs/05 §5.7:
 *     the key, the explanation, the teacher's comment and the hidden test
 *     bodies each leave the server only when the policy says so.
 *
 * `results` owns no table. It reads `gradings` (the `grading` module's),
 * `answers` and `attempts` (`live`'s) and `evaluations` (`evaluation`'s) by
 * join, and the only column it writes is the release pair of `evaluations`,
 * which is what a release IS.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import type {
  AnswerDistributionEntry,
  ByQuestion,
  FeedbackPolicy,
  GradingScale,
  ReleasedGrades,
  ResultCard,
  ResultRow,
  ResultsItem,
  ResultsView,
  StudentFeedback,
  StudentResultItem,
} from "@quiz/contracts";
import { describe, gradeFromPoints, histogram, round2 } from "@quiz/domain";
import { studentDetails as codeStudentDetails, CodeDetails } from "@quiz/qt-code/server";

import { iso, isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import {
  answers,
  attempts,
  classrooms,
  courses,
  enrollments,
  evaluations,
  gradings,
} from "../../db/schema.js";
import {
  feedbackOf,
  joinedItems,
  scaleOf,
  settingsOf,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import { pairKey, validatedGradings, verdictOf, type GradingRecord, type PairKey } from "../grading/service.js";
import { solutionView, studentView } from "../live/studentView.js";

export class ResultsError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ResultsError";
  }
}

export class NotReleasable extends ResultsError {
  constructor(message: string) {
    super("not_releasable", 409, message);
  }
}

// --- The grade table ------------------------------------------------------

export interface ComputedResults {
  totalPoints: number;
  scale: GradingScale;
  items: ResultsItem[];
  rows: ResultRow[];
}

/**
 * Every row of the grade table, including the students who never showed up
 * (F-RES-02: the export is the class list, not the attempt list).
 */
export async function computeResults(
  db: Db,
  evaluation: EvaluationRecord,
): Promise<ComputedResults> {
  const items = await joinedItems(db, evaluation.id);
  const totalPoints = round2(items.reduce((sum, i) => sum + i.item.points, 0));
  const scale = scaleOf(evaluation);

  const roster = await db
    .select({
      userId: enrollments.userId,
      nom: enrollments.nom,
      prenom: enrollments.prenom,
      email: enrollments.email,
    })
    .from(enrollments)
    .where(and(eq(enrollments.classroomId, evaluation.classroomId), eq(enrollments.staff, false)))
    .orderBy(asc(enrollments.nom), asc(enrollments.prenom));

  const attemptRows = await db
    .select()
    .from(attempts)
    .where(eq(attempts.evaluationId, evaluation.id));
  const byUser = new Map(attemptRows.map((a) => [a.userId, a]));
  const validated = await validatedGradings(db, evaluation.id);

  const rows: ResultRow[] = [];
  for (const entry of roster) {
    if (entry.userId === null) continue;
    const attempt = byUser.get(entry.userId) ?? null;
    const perItem: Record<string, number> = {};
    let points = 0;
    if (attempt) {
      for (const item of items) {
        const grading = validated.get(pairKey(attempt.id, item.item.id));
        if (!grading) continue;
        perItem[item.item.id] = grading.points;
        points += grading.points;
      }
    }
    points = round2(points);
    rows.push({
      userId: entry.userId,
      displayName: `${entry.prenom} ${entry.nom}`.trim() || entry.email,
      lastName: entry.nom,
      firstName: entry.prenom,
      email: entry.email,
      attemptId: attempt?.id ?? null,
      perItem,
      points,
      grade: gradeFromPoints(points, totalPoints, scale),
      durationS: durationOf(attempt),
      state: attempt ? attempt.state : "absent",
    });
  }

  return { totalPoints, scale, items: itemViews(items, validated), rows };
}

function durationOf(
  attempt: { startedAt: Date | null; submittedAt: Date | null; closedAt: Date | null } | null,
): number | null {
  if (!attempt?.startedAt) return null;
  const end = attempt.submittedAt ?? attempt.closedAt;
  if (!end) return null;
  return Math.max(0, Math.round((end.getTime() - attempt.startedAt.getTime()) / 1000));
}

/** Per-item success rate: the mean of `points / maxPoints` over the class. */
function itemViews(
  items: readonly JoinedItem[],
  validated: ReadonlyMap<PairKey, GradingRecord>,
): ResultsItem[] {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const grading of validated.values()) {
    if (grading.maxPoints <= 0) continue;
    const acc = sums.get(grading.itemId) ?? { sum: 0, n: 0 };
    acc.sum += grading.points / grading.maxPoints;
    acc.n += 1;
    sums.set(grading.itemId, acc);
  }
  return items.map((i) => {
    const acc = sums.get(i.item.id);
    return {
      id: i.item.id,
      position: i.item.position,
      internalName: i.question.internalName,
      type: i.question.type,
      points: i.item.points,
      successRate: acc && acc.n > 0 ? round2(acc.sum / acc.n) : null,
    };
  });
}

export async function resultsView(db: Db, evaluation: EvaluationRecord): Promise<ResultsView> {
  const computed = await computeResults(db, evaluation);
  // Absent students count in the mean: a 1.0 that is not in the statistics
  // would flatter every class average (F-RES-01).
  const grades = computed.rows.map((r) => r.grade);
  const stats = describe(grades);
  return {
    evaluationId: evaluation.id,
    title: evaluation.title,
    totalPoints: computed.totalPoints,
    scale: computed.scale,
    released: evaluation.releasedAt !== null,
    releasedAt: isoOrNull(evaluation.releasedAt),
    modifiedAfterRelease: evaluation.modifiedAfterRelease,
    items: computed.items,
    rows: computed.rows,
    stats: { ...stats, histogram: histogram(grades) },
  };
}

// --- Release (F-RES-04, F-GRADE-09) --------------------------------------

/**
 * The release, in ONE transaction: the frozen snapshot and the instant are
 * written together, and the state moves to `released`. Idempotent — releasing
 * an already released evaluation recomputes the snapshot, clears
 * `modified_after_release` and keeps the ORIGINAL `released_at`, which is the
 * date the students were told about.
 */
export async function releaseResults(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<{ releasedAt: Date; rows: number }> {
  if (evaluation.state !== "closed" && evaluation.state !== "grading" && evaluation.state !== "released") {
    throw new NotReleasable("an evaluation is released once it is closed");
  }
  const computed = await computeResults(db, evaluation);
  const releasedAt = evaluation.releasedAt ?? now;
  const snapshot: ReleasedGrades = {
    releasedAt: iso(releasedAt),
    totalPoints: computed.totalPoints,
    scale: computed.scale,
    rows: computed.rows.map((r) => ({
      attemptId: r.attemptId,
      userId: r.userId,
      points: r.points,
      grade: r.grade,
      perItem: r.perItem,
    })),
  };
  await db.transaction(async (tx) => {
    await tx
      .update(evaluations)
      .set({
        releasedAt,
        releasedGrades: snapshot,
        modifiedAfterRelease: false,
        state: "released",
        updatedAt: now,
      })
      .where(eq(evaluations.id, evaluation.id));
  });
  return { releasedAt, rows: computed.rows.length };
}

/** Withdrawing a release: the students stop seeing anything again. */
export async function unreleaseResults(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<void> {
  await db
    .update(evaluations)
    .set({
      releasedAt: null,
      releasedGrades: null,
      modifiedAfterRelease: false,
      state: "closed",
      updatedAt: now,
    })
    .where(eq(evaluations.id, evaluation.id));
}

/**
 * F-GRADE-09: a correction that lands after the release marks the evaluation
 * "modified after publication". The students see the new grade — the flag is
 * what tells the teacher to re-publish (or to explain).
 */
export async function markModifiedAfterRelease(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<boolean> {
  if (evaluation.releasedAt === null) return false;
  await db
    .update(evaluations)
    .set({ modifiedAfterRelease: true, updatedAt: now })
    .where(eq(evaluations.id, evaluation.id));
  return true;
}

// --- Per-question view (F-RES-03) ----------------------------------------

export async function byQuestion(db: Db, evaluation: EvaluationRecord): Promise<ByQuestion[]> {
  const items = await joinedItems(db, evaluation.id);
  const validated = await validatedGradings(db, evaluation.id);
  const views = itemViews(items, validated);
  const attemptRows = await db
    .select({ id: attempts.id, seed: attempts.seed })
    .from(attempts)
    .where(eq(attempts.evaluationId, evaluation.id));
  const answerRows =
    attemptRows.length === 0
      ? []
      : await db
          .select()
          .from(answers)
          .where(
            inArray(
              answers.attemptId,
              attemptRows.map((a) => a.id),
            ),
          );

  return items.map((item, index) => {
    const version = { config: item.version.config, configVersion: item.version.configVersion };
    const itemAnswers = answerRows.filter(
      (a) => a.itemId === item.item.id && a.payload !== null,
    );
    const itemGradings = [...validated.values()].filter((g) => g.itemId === item.item.id);
    return {
      item: views[index]!,
      student: studentView({
        type: item.question.type,
        version,
        seed: 0,
        itemId: item.item.id,
        shuffle: false,
      }),
      solution: solutionView({
        type: item.question.type,
        version,
        seed: 0,
        itemId: item.item.id,
      }),
      explanation: item.version.explanation === "" ? null : item.version.explanation,
      answered: itemAnswers.length,
      distribution: distributionOf(item.question.type, itemAnswers.map((a) => a.payload)),
      casePassRate: casePassRateOf(itemGradings),
      successRate: views[index]!.successRate,
      avgMs: null,
    };
  });
}

/**
 * The answer distribution of §4.6. `mcq` is counted by canonical choice index
 * (decision D3 makes that index meaningless to a student, and exact for the
 * teacher); `short` and `cloze` are counted by the text the student typed,
 * which is what makes "everybody wrote 'Galilee'" visible.
 */
export function distributionOf(type: string, payloads: readonly unknown[]): AnswerDistributionEntry[] {
  const counts = new Map<string, number>();
  const add = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

  for (const payload of payloads) {
    if (type === "mcq" && payload && typeof payload === "object" && "selected" in payload) {
      const selected = (payload as { selected: unknown }).selected;
      if (Array.isArray(selected)) for (const index of new Set(selected)) add(String(index));
      continue;
    }
    if (type === "cloze" && payload && typeof payload === "object" && "blanks" in payload) {
      const blanks = (payload as { blanks: unknown }).blanks;
      if (Array.isArray(blanks)) {
        for (const [index, value] of blanks.entries()) add(`${index}: ${String(value ?? "")}`);
      }
      continue;
    }
    if (typeof payload === "string") {
      add(payload.trim());
      continue;
    }
    if (payload && typeof payload === "object" && "text" in payload) {
      add(String((payload as { text: unknown }).text ?? "").trim());
      continue;
    }
    // `code` and anything else: the distribution is meaningless, the case
    // pass rate is the useful number and it is computed separately.
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([key, count]) => ({ key, label: key === "" ? "(vide)" : key, count, correct: null }));
}

/** `code`: how many attempts passed each named test case (F-RES-03). */
export function casePassRateOf(
  rows: readonly { details: unknown }[],
): { name: string; passed: number; total: number }[] {
  const tally = new Map<string, { passed: number; total: number }>();
  for (const row of rows) {
    const parsed = CodeDetails.safeParse(row.details);
    if (!parsed.success) continue;
    for (const c of parsed.data.cases) {
      const acc = tally.get(c.name) ?? { passed: 0, total: 0 };
      acc.total += 1;
      if (c.ok) acc.passed += 1;
      tally.set(c.name, acc);
    }
  }
  return [...tally.entries()].map(([name, acc]) => ({ name, ...acc }));
}

// --- Student feedback (F-RES-04, docs/05 §5.7) ---------------------------

/** Whether a student may see anything at all right now. */
export function feedbackAvailable(
  policy: FeedbackPolicy,
  evaluation: EvaluationRecord,
  attemptState: string,
): { ok: true } | { ok: false; reason: "results_pending" | "no_feedback" | "attempt_open" } {
  if (policy.when === "none") return { ok: false, reason: "no_feedback" };
  if (attemptState === "in_progress" || attemptState === "not_started") {
    return { ok: false, reason: "attempt_open" };
  }
  if (policy.when === "immediate") return { ok: true };
  return evaluation.releasedAt === null ? { ok: false, reason: "results_pending" } : { ok: true };
}

/**
 * THE application of the feedback policy. Nothing else in the API builds a
 * result payload for a student, exactly as nothing else builds a question
 * payload for one (invariant 4).
 */
export async function studentFeedback(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: typeof attempts.$inferSelect,
): Promise<StudentFeedback> {
  const policy = feedbackOf(evaluation);
  const gate = feedbackAvailable(policy, evaluation, attempt.state);
  if (!gate.ok) {
    return {
      available: false,
      reason: gate.reason,
      evaluation: { id: evaluation.id, title: evaluation.title },
    };
  }

  const items = await joinedItems(db, evaluation.id);
  const totalPoints = round2(items.reduce((sum, i) => sum + i.item.points, 0));
  const answerRows = await db.select().from(answers).where(eq(answers.attemptId, attempt.id));
  const byItem = new Map(answerRows.map((a) => [a.itemId, a]));
  const graded = await db
    .select()
    .from(gradings)
    .where(and(eq(gradings.attemptId, attempt.id), eq(gradings.state, "validated")));
  const gradingByItem = new Map(graded.map((g) => [g.itemId, g]));
  const settings = settingsOf(evaluation);

  let points = 0;
  const result: StudentResultItem[] = items.map((item) => {
    const grading = gradingByItem.get(item.item.id) ?? null;
    if (grading) points += grading.points;
    const answer = byItem.get(item.item.id) ?? null;
    const version = { config: item.version.config, configVersion: item.version.configVersion };
    const view = {
      type: item.question.type,
      version,
      seed: attempt.seed,
      itemId: item.item.id,
    };
    return {
      itemId: item.item.id,
      position: item.item.position,
      points: grading ? grading.points : null,
      maxPoints: item.item.points,
      verdict: grading ? verdictOf(grading) : null,
      student: studentView({
        ...view,
        shuffle: settings.shuffleChoices && item.question.shuffleable,
      }),
      answer: policy.showAnswer ? (answer?.payload ?? null) : null,
      solution: policy.showKey ? solutionView(view) : null,
      explanation:
        policy.showExplanation && item.version.explanation !== ""
          ? item.version.explanation
          : null,
      details: grading ? filterDetails(item.question.type, grading.details, policy) : null,
      comment: policy.showTeacherComment ? (grading?.comment ?? null) : null,
    };
  });

  points = round2(points);
  return {
    available: true,
    evaluation: {
      id: evaluation.id,
      title: evaluation.title,
      releasedAt: isoOrNull(evaluation.releasedAt),
    },
    attemptId: attempt.id,
    points,
    totalPoints,
    grade: gradeFromPoints(points, totalPoints, scaleOf(evaluation)),
    items: result,
  };
}

/**
 * The per-type redaction of `gradings.details` (§4.6, decision D15).
 *
 * `code` is the only MVP type whose details hold a secret: the hidden cases'
 * expected and actual output. `studentDetails` (deviation W3-5) keeps
 * `{ name, ok, points }` for a hidden case and drops the bodies, and hides the
 * NAME too unless `showHiddenCaseNames`. `showKey` means the teacher chose to
 * publish the key, so the details travel whole.
 */
export function filterDetails(
  type: string,
  details: unknown,
  policy: FeedbackPolicy,
): unknown {
  if (details === null || details === undefined) return null;
  if (type !== "code" || policy.showKey) return details;
  const parsed = CodeDetails.safeParse(details);
  if (!parsed.success) return details;
  return codeStudentDetails(parsed.data, { showHiddenCaseNames: policy.showHiddenCaseNames });
}

/** `GET /student/results` — one card per released evaluation the student took. */
export async function studentResultCards(db: Db, userId: string): Promise<ResultCard[]> {
  const rows = await db
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
    .where(and(eq(enrollments.userId, userId), eq(enrollments.status, "claimed")));

  const cards: ResultCard[] = [];
  for (const row of rows) {
    if (row.evaluation.releasedAt === null) continue;
    const grade = await gradeOfAttempt(db, row.evaluation, row.attempt?.id ?? null);
    cards.push({
      evaluationId: row.evaluation.id,
      title: row.evaluation.title,
      classroomId: row.evaluation.classroomId,
      classroomName: row.classroomName,
      courseCode: row.courseCode,
      attemptId: row.attempt?.id ?? null,
      releasedAt: isoOrNull(row.evaluation.releasedAt),
      ...grade,
    });
  }
  return cards;
}

/**
 * The grade of one attempt, recomputed from the validated gradings.
 *
 * F-GRADE-09 is explicit: a re-correction after the release UPDATES the
 * grades. The frozen `released_grades` is therefore the record of what was
 * published, not the number the student is shown — and `modified_after_release`
 * is what tells the teacher the two have drifted apart.
 */
export async function gradeOfAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  attemptId: string | null,
): Promise<{ points: number; totalPoints: number; grade: number }> {
  const items = await joinedItems(db, evaluation.id);
  const totalPoints = round2(items.reduce((sum, i) => sum + i.item.points, 0));
  if (attemptId === null) {
    return { points: 0, totalPoints, grade: gradeFromPoints(0, totalPoints, scaleOf(evaluation)) };
  }
  const rows = await db
    .select({ points: gradings.points })
    .from(gradings)
    .where(and(eq(gradings.attemptId, attemptId), eq(gradings.state, "validated")));
  const points = round2(rows.reduce((sum, r) => sum + r.points, 0));
  return { points, totalPoints, grade: gradeFromPoints(points, totalPoints, scaleOf(evaluation)) };
}
