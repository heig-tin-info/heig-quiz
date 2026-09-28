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
 * join. The release pair of `evaluations`, which is what a release IS, is
 * written through the `evaluation` module's narrow writers (`setRelease`,
 * `clearRelease`, `setModifiedAfterRelease`), never by an UPDATE of its own.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import type {
  ByQuestion,
  CardResults,
  FeedbackPolicy,
  GradingScale,
  ReleasedGrades,
  ResultCard,
  ResultRow,
  ResultsItem,
  ResultsView,
  RetakeStatus,
  StudentFeedback,
  StudentResultItem,
} from "@quiz/contracts";
import {
  attemptTotal,
  debrief,
  describe,
  gradeFromPoints,
  histogram,
  retakeRefusal,
  round2,
  type AttemptTally,
} from "@quiz/domain";

import { iso, isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import {
  answers,
  attempts,
  enrollments,
  gradings,
} from "../../db/schema.js";
import { DomainError } from "../http.js";
import {
  applyState,
  cachedGrade,
  clearRelease,
  feedbackOf,
  gradeDefaults,
  joinedItems,
  retakePolicyOf,
  retakesEnabled,
  classroomIdOf,
  scaleOf,
  seatsOf,
  setModifiedAfterRelease,
  setRelease,
  settingsOf,
  staffAttemptIds,
  staffRosterWithAttempt,
  studentEvaluationRows,
  totalPointsByEvaluation,
  totalPointsOf,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import { notifyMany, withdrawResultsReleased } from "../notifications/service.js";
import {
  keptAttempts,
  pairKey,
  pointsByAttempt,
  scoreOf,
  studentAttempts,
  tallyByAttempt,
  validatedGradings,
  verdictOf,
  type GradingRecord,
  type PairKey,
  type StudentAttempts,
} from "../grading/service.js";
import { answeredBy } from "../live/service.js";
import { solutionView, stripKeys, studentView } from "../live/studentView.js";
import { typeOf } from "../pool/config.js";

export { watchReleasedGrades, type GradeWatch } from "./updated.js";

export class ResultsError extends DomainError {
  override name = "ResultsError";
}

export class NotReleasable extends ResultsError {
  constructor(message: string) {
    super("not_releasable", 409, message);
  }
}

export class NotOver extends ResultsError {
  constructor(message: string) {
    super("not_over", 409, message);
  }
}

/** Closed, being graded or released: what the web calls `isGraded`. */
function isOver(evaluation: EvaluationRecord): boolean {
  return (
    evaluation.state === "closed" || evaluation.state === "grading" || evaluation.state === "released"
  );
}

// --- The grade table ------------------------------------------------------

interface ComputedResults {
  totalPoints: number;
  scale: GradingScale;
  items: ResultsItem[];
  rows: ResultRow[];
}

/**
 * Every row of the grade table, including the students who never showed up
 * (F-RES-02: the export is the class list, not the attempt list).
 */
async function computeResults(
  db: Db,
  evaluation: EvaluationRecord,
): Promise<ComputedResults> {
  const items = await joinedItems(db, evaluation.id);
  const totalPoints = totalPointsOf(items.map((i) => i.item));
  const scale = scaleOf(evaluation);

  const roster = await db
    .select({
      userId: enrollments.userId,
      nom: enrollments.nom,
      prenom: enrollments.prenom,
      email: enrollments.email,
    })
    .from(enrollments)
    .where(and(seatsOf(evaluation), eq(enrollments.staff, false)))
    .orderBy(asc(enrollments.nom), asc(enrollments.prenom));
  /*
   * The teacher's own test walk, appended after the class and flagged
   * (ADR-018). It is a ROW because the teacher wants to read the grade their
   * own answers earned; it is not a STUDENT, so `resultsView` keeps it out
   * of the statistics, `itemViews` out of the success rates, the CSV out of
   * the file and the release out of the frozen snapshot.
   */
  const staffSeats = await staffRosterWithAttempt(db, evaluation);

  // The attempt that COUNTS for each student: their only one, or with
  // retakes the best or the last (F-EVAL-15, ADR-025). The grade, the CSV,
  // the release and the statistics all read this one map.
  const byUser = await keptAttempts(db, evaluation);
  const staffAttempts = await staffAttemptIds(db, evaluation);
  const validated = await validatedGradings(db, evaluation.id);

  const rows: ResultRow[] = [];
  const seats = [
    ...roster.map((entry) => ({ ...entry, staff: false })),
    ...staffSeats.map((entry) => ({ ...entry, staff: true })),
  ];
  for (const entry of seats) {
    if (entry.userId === null) continue;
    const attempt = byUser.get(entry.userId) ?? null;
    const perItem: Record<string, number> = {};
    if (attempt) {
      for (const item of items) {
        const grading = validated.get(pairKey(attempt.id, item.item.id));
        if (!grading) continue;
        perItem[item.item.id] = grading.points;
      }
    }
    // Per item, the points as graded — negative ones included (ADR-026);
    // the total is `attemptTotal`'s, floored at 0, and the grade comes from it.
    const points = attemptTotal(Object.values(perItem));
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
      staff: entry.staff,
    });
  }

  return {
    totalPoints,
    scale,
    items: itemViews(items, validated, countedAttempts(byUser, staffAttempts)),
    rows,
  };
}

/**
 * The attempts the statistics count: each student's kept attempt, and not a
 * teacher's own test (ADR-018). With retakes, the per-question figures are
 * those of the attempts the grades come from — one per student — not of
 * every try (ADR-025).
 */
function countedAttempts(
  kept: ReadonlyMap<string, { id: string }>,
  staffAttempts: ReadonlySet<string>,
): Set<string> {
  return new Set([...kept.values()].map((a) => a.id).filter((id) => !staffAttempts.has(id)));
}

function durationOf(
  attempt: { startedAt: Date | null; submittedAt: Date | null; closedAt: Date | null } | null,
): number | null {
  if (!attempt?.startedAt) return null;
  const end = attempt.submittedAt ?? attempt.closedAt;
  if (!end) return null;
  return Math.max(0, Math.round((end.getTime() - attempt.startedAt.getTime()) / 1000));
}

/**
 * Per-item success rate: the mean of `points / maxPoints` over the CLASS —
 * the `counted` attempts, one per student (see {@link countedAttempts}). The
 * teachers' own test walks (ADR-018) are not among them: a teacher who knows
 * the key would otherwise pull every rate up.
 */
function itemViews(
  items: readonly JoinedItem[],
  validated: ReadonlyMap<PairKey, GradingRecord>,
  counted: ReadonlySet<string>,
): ResultsItem[] {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const grading of validated.values()) {
    if (!counted.has(grading.attemptId)) continue;
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
  // would flatter every class average (F-RES-01). A teacher's own test does
  // NOT: it is not a member of the class (ADR-018).
  const grades = computed.rows.filter((r) => !r.staff).map((r) => r.grade);
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
  if (!isOver(evaluation)) {
    throw new NotReleasable("an evaluation is released once it is closed");
  }
  const computed = await computeResults(db, evaluation);
  const releasedAt = evaluation.releasedAt ?? now;
  const snapshot: ReleasedGrades = {
    releasedAt: iso(releasedAt),
    totalPoints: computed.totalPoints,
    scale: computed.scale,
    // The frozen snapshot is the CLASS's grades (ADR-012); a teacher's own
    // test is not one of them and has nothing to freeze (ADR-018).
    rows: computed.rows
      .filter((r) => !r.staff)
      .map((r) => ({
        attemptId: r.attemptId,
        userId: r.userId,
        points: r.points,
        grade: r.grade,
        perItem: r.perItem,
      })),
  };
  await setRelease(db, evaluation.id, { releasedAt, releasedGrades: snapshot }, now);
  // F-GRADE-09: the students are told — on the FIRST release only. A
  // re-release keeps the original `released_at`, the date they were told
  // about, and telling them twice would announce nothing new. Only a student
  // with an attempt has a feedback page to open; an absent one is not told.
  if (evaluation.releasedAt === null) {
    await notifyMany(
      db,
      snapshot.rows.flatMap((row) =>
        row.attemptId === null
          ? []
          : [
              {
                userId: row.userId,
                payload: {
                  kind: "results_released" as const,
                  evaluationId: evaluation.id,
                  evaluationTitle: evaluation.title,
                  attemptId: row.attemptId,
                },
              },
            ],
      ),
    );
  }
  return { releasedAt, rows: snapshot.rows.length };
}

/**
 * Withdrawing a release: the students stop seeing anything again.
 *
 * The release pair is cleared FIRST and the state moved after, through
 * `applyState` — the one definition of the arrow `released → closed`
 * (§5.1). An interruption between the two therefore leaves an evaluation
 * that says `released` but shows nothing, never one that says `closed` and
 * still serves the grades.
 */
export async function unreleaseResults(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<void> {
  // Both or neither: a cleared `released_at` on a row still `released`
  // would leave the two readings of "released" disagreeing.
  await db.transaction(async (tx) => {
    await clearRelease(tx, evaluation.id, now);
    await applyState(tx, evaluation, "closed", now);
  });
  // The bells that announced it, or a correction of it, would open a page
  // that shows nothing now.
  await withdrawResultsReleased(db, evaluation.id);
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
  // Re-read by the UPDATE, not trusted from `evaluation`, which the caller
  // loaded before its own writes (a release may have committed since).
  return setModifiedAfterRelease(db, evaluation.id, now);
}

// --- Per-question view (F-RES-03) ----------------------------------------

/**
 * The debrief of every item — the Results "Questions" tab and its projection
 * in class (ADR-033). Only once the evaluation is over: before, a projected
 * key would reach a student still answering, or one about to retake.
 */
export async function byQuestion(db: Db, evaluation: EvaluationRecord): Promise<ByQuestion[]> {
  if (!isOver(evaluation)) throw new NotOver("the debrief of a question waits for the close");
  const items = await joinedItems(db, evaluation.id);
  const validated = await validatedGradings(db, evaluation.id);
  // The class debrief is about the CLASS: the teacher's own rehearsal is not
  // in the success rates and not in the answer distributions (ADR-018).
  const staffAttempts = await staffAttemptIds(db, evaluation);
  // One attempt per student, the one that counts (ADR-025).
  const counted = countedAttempts(await keptAttempts(db, evaluation), staffAttempts);
  const views = itemViews(items, validated, counted);
  const answerRows =
    counted.size === 0
      ? []
      : await db.select().from(answers).where(inArray(answers.attemptId, [...counted]));
  const answerOf = new Map(answerRows.map((a) => [pairKey(a.attemptId, a.itemId), a]));
  // Hidden case names reach the wall as a student would read them (ADR-033).
  const { showHiddenCaseNames } = feedbackOf(evaluation);

  return items.map((item, index) => {
    const version = { config: item.version.config, configVersion: item.version.configVersion };
    const holdsAnswer = answeredBy(item);
    const type = typeOf(item.question.type);
    // Per attempt, so that what it wrote can take the verdict of its grading;
    // the per-type statistics come from the type itself (audit B-15).
    const tallies: AttemptTally[] = [];
    for (const attemptId of counted) {
      const cell = pairKey(attemptId, item.item.id);
      const answer = answerOf.get(cell);
      if (!answer || answer.skipped || !holdsAnswer(answer.payload)) {
        tallies.push({ grading: null, aggregate: {} });
        continue;
      }
      const grading = validated.get(cell);
      // A proposal is not a zero: the answer waits, and counts nowhere yet.
      if (!grading) continue;
      tallies.push({
        grading,
        aggregate:
          type.aggregate?.({
            answers: [answer.payload],
            details: [grading.details],
            showHiddenCaseNames,
          }) ?? {},
      });
    }
    const { outcomes, successRate, distribution, casePassRate } = debrief(tallies);
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
      outcomes,
      distribution,
      casePassRate,
      successRate,
      avgMs: null,
    };
  });
}

// --- Student feedback (F-RES-04, docs/05 §5.7) ---------------------------

/**
 * An exercise that allows retakes, while it still takes them (ADR-025): the
 * student reads the SCORE of a finished attempt and nothing else, whatever
 * the policy says — the correction of attempt 1 would be the key of
 * attempt 2. Once the evaluation is closed the teacher's feedback policy
 * decides, unchanged: `immediate` shows the correction, `on_release` waits
 * for the release, `none` shows nothing — the score included.
 * The score is shown under `none` too: a retake without it has no point, and
 * enabling retakes is the teacher's consent to it.
 */
function scoreOnly(evaluation: EvaluationRecord): boolean {
  return (
    retakesEnabled(evaluation) &&
    (evaluation.state === "lobby" || evaluation.state === "running" || evaluation.state === "paused")
  );
}

/**
 * Whether a student may read the SCORE of this attempt right now: while the
 * exercise still takes retakes (score only, ADR-025), or whenever the
 * feedback policy lets the results through. The student home asks this
 * before it prints a kept score, so the card never says more than the
 * feedback page would.
 */
export function scoreVisible(evaluation: EvaluationRecord, attemptState: string): boolean {
  return feedbackAvailable(feedbackOf(evaluation), evaluation, attemptState).ok
    || (scoreOnly(evaluation) && attemptState !== "in_progress" && attemptState !== "not_started");
}

/**
 * What the feedback page of the attempt that counts would give the student
 * (issue #203): `available` when it answers `available: true`; `none` when
 * nothing will ever be published — no attempt, or the policy `none` (between
 * two attempts `retakes_open` comes first, but the close will not change
 * `none`); `pending` otherwise, the results still to come. The student home
 * offers "See my results" only on `available`, so the button never leads to
 * "not published yet". {@link feedbackAvailable} stays the one rule.
 */
export function resultsState(
  evaluation: EvaluationRecord,
  attemptState: string | null,
): CardResults {
  if (attemptState === null) return "none";
  const policy = feedbackOf(evaluation);
  const gate = feedbackAvailable(policy, evaluation, attemptState);
  if (gate.ok) return "available";
  if (gate.reason === "no_feedback") return "none";
  if (gate.reason === "retakes_open" && policy.when === "none") return "none";
  return "pending";
}

/** Whether a student may see anything at all right now. */
function feedbackAvailable(
  policy: FeedbackPolicy,
  evaluation: EvaluationRecord,
  attemptState: string,
):
  | { ok: true }
  | { ok: false; reason: "results_pending" | "no_feedback" | "attempt_open" | "retakes_open" } {
  const open = attemptState === "in_progress" || attemptState === "not_started";
  if (!open && scoreOnly(evaluation)) return { ok: false, reason: "retakes_open" };
  if (policy.when === "none") return { ok: false, reason: "no_feedback" };
  if (open) return { ok: false, reason: "attempt_open" };
  if (policy.when === "immediate") return { ok: true };
  return evaluation.releasedAt === null ? { ok: false, reason: "results_pending" } : { ok: true };
}

/**
 * Whether this student may start another attempt now, and why not: the
 * server's own rule (`retakeRefusal`), the one `POST /evaluations/:id/retake`
 * applies, so the results page offers exactly what the route would accept
 * (issues #120, #121).
 */
async function retakeStatus(
  db: Db,
  evaluation: EvaluationRecord,
  userId: string,
  now: Date,
): Promise<RetakeStatus> {
  const policy = retakePolicyOf(evaluation);
  const mine = (await studentAttempts(db, userId, [evaluation])).get(evaluation.id)?.all ?? [];
  return {
    evaluationId: evaluation.id,
    keep: policy.keep,
    maxAttempts: policy.maxAttempts,
    attemptCount: mine.length,
    refusal: retakeRefusal({
      mode: evaluation.mode,
      retakes: policy,
      evaluationState: evaluation.state,
      closesAt: evaluation.closesAt,
      now,
      attempts: mine,
    }),
  };
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
  now: Date,
): Promise<StudentFeedback> {
  const policy = feedbackOf(evaluation);
  const gate = feedbackAvailable(policy, evaluation, attempt.state);
  if (!gate.ok) {
    const pending = {
      available: false as const,
      reason: gate.reason,
      evaluation: { id: evaluation.id, title: evaluation.title },
    };
    if (gate.reason !== "retakes_open") return pending;
    // The points of THIS attempt, and not one item: no verdict, no answer,
    // no key (ADR-025).
    const items = await joinedItems(db, evaluation.id);
    const tally = (await tallyByAttempt(db, [attempt.id])).get(attempt.id);
    return {
      ...pending,
      score: scoreOf(tally, items.length, totalPointsOf(items.map((i) => i.item))),
      ...(attempt.userId === null
        ? {}
        : { retake: await retakeStatus(db, evaluation, attempt.userId, now) }),
    };
  }

  const items = await joinedItems(db, evaluation.id);
  const totalPoints = totalPointsOf(items.map((i) => i.item));
  const answerRows = await db.select().from(answers).where(eq(answers.attemptId, attempt.id));
  const byItem = new Map(answerRows.map((a) => [a.itemId, a]));
  const graded = await db
    .select()
    .from(gradings)
    .where(and(eq(gradings.attemptId, attempt.id), eq(gradings.state, "validated")));
  const gradingByItem = new Map(graded.map((g) => [g.itemId, g]));
  const settings = settingsOf(evaluation);

  const result: StudentResultItem[] = items.map((item) => {
    const grading = gradingByItem.get(item.item.id) ?? null;
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
      type: item.question.type,
      points: grading ? grading.points : null,
      maxPoints: item.item.points,
      verdict: grading ? verdictOf(grading) : null,
      student: studentView({
        ...view,
        shuffle: settings.shuffleChoices && item.question.shuffleable,
        defaults: gradeDefaults(evaluation),
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

  // The same total as the grade table (`attemptTotal`, floored at 0 under
  // negative marking, ADR-026), over the same validated gradings.
  const points = attemptTotal(result.flatMap((r) => (r.points === null ? [] : [r.points])));
  // The total is the frozen one while it still holds (D-06); the per-item
  // points above always come from the gradings, which the snapshot mirrors.
  const hit =
    attempt.userId === null ? null : cachedGrade(evaluation, attempt.userId, attempt.id);
  return {
    available: true,
    evaluation: {
      id: evaluation.id,
      title: evaluation.title,
      releasedAt: isoOrNull(evaluation.releasedAt),
    },
    attemptId: attempt.id,
    points: hit ? hit.points : points,
    totalPoints: hit ? hit.totalPoints : totalPoints,
    grade: hit ? hit.grade : gradeFromPoints(points, totalPoints, scaleOf(evaluation)),
    items: result,
  };
}

/**
 * The per-type redaction of `gradings.details` (§4.6, decision D15).
 *
 * `gradings.details` is written by `type.grade` FOR THE TEACHER: it holds
 * whatever justifies the score — the correct choices of an `mcq`, every
 * expected blank of a `cloze`, which matcher a `short` answer hit, a `code`
 * question's hidden cases. It is the one payload that does not travel through
 * `toStudent`, so the policy is applied here, in two layers:
 *
 *   1. the type's own {@link QuestionTypeServer.studentDetails} hook, which
 *      knows what its breakdown means and keeps the feedback that is not a
 *      key (the verdicts, the student's own text, the case pass/fail);
 *   2. a blind strip of {@link FORBIDDEN_DETAIL_KEYS}, so a type that gains a
 *      key-bearing field and forgets the hook still cannot publish it.
 *
 * `showKey` means the teacher chose to publish the key: the details travel
 * whole, both layers off.
 *
 * The list is its OWN, not `FORBIDDEN_STUDENT_KEYS` (`live/studentView.ts`):
 * what carries a key in a grading breakdown is these five fields, and
 * `details` may also be a teacher's manual override of any shape, which the
 * question-payload list would redact for no reason (`explanation`,
 * `answers`, …). Four of the five are on the common floor of `@quiz/core`;
 * `expected` is not, because a visible code case publishes it
 * (`results.db.test.ts` pins both facts).
 */
export const FORBIDDEN_DETAIL_KEYS: readonly string[] = [
  "correct",
  "expected",
  "matchers",
  "pattern",
  "referenceSolution",
];

const forbiddenDetailKeys = new Set(FORBIDDEN_DETAIL_KEYS);

/**
 * The one exception of layer 2, and it is the published half of a `code`
 * question: the expected output of a case the teacher marked `visible` is
 * already in the student's own question payload (`toStudent`, deviation
 * W3-4), so removing it here would only blank the comparison the review
 * shows. A hidden case never carries one by the time it gets here — layer 1
 * removed it.
 */
const publishedExpected = (object: Record<string, unknown>, key: string): boolean =>
  key === "expected" && object["visible"] === true;

export function filterDetails(
  type: string,
  details: unknown,
  policy: FeedbackPolicy,
): unknown {
  if (details === null || details === undefined) return null;
  if (policy.showKey) return details;
  const hook = typeOf(type).studentDetails;
  const shaped = hook ? hook(details, policy) : details;
  return stripKeys(shaped, forbiddenDetailKeys, publishedExpected);
}

/** A row of `studentEvaluationRows`: one per evaluation, with the latest attempt. */
type StudentRow = Awaited<ReturnType<typeof studentEvaluationRows>>[number];

/**
 * The attempt that counts (F-EVAL-15): with retakes, the best or the last
 * one (`retaking`, from `studentAttempts`); otherwise the student's only
 * attempt, which the row already holds.
 */
export function countedAttempt(retaking: ReadonlyMap<string, StudentAttempts>, row: StudentRow) {
  const mine = retaking.get(row.evaluation.id);
  return mine ? mine.kept : (row.attempt ?? null);
}

/** {@link countedAttempt}'s id. */
export function countedAttemptId(
  retaking: ReadonlyMap<string, StudentAttempts>,
  row: StudentRow,
): string | null {
  return countedAttempt(retaking, row)?.id ?? null;
}

export interface ReleasedGrade {
  attemptId: string | null;
  points: number;
  totalPoints: number;
  grade: number;
}

/**
 * The grade of each RELEASED row, keyed by evaluation id: what the student
 * home and the results page both show. `retaking` holds the student's
 * attempts of (at least) every row with retakes.
 *
 * The grade frozen at release is served as long as it is still true
 * (`cachedGrade`, D-06). F-GRADE-09 is explicit: a re-correction after the
 * release UPDATES the grades, so once `modified_after_release` is set they
 * are recomputed from the validated gradings of the counted attempt
 * ({@link gradeShown}). Two grouped queries for the rows that need it, not two
 * per row — and none when every row is cached.
 */
export async function releasedGradesOf(
  db: Db,
  userId: string,
  rows: readonly StudentRow[],
  retaking: ReadonlyMap<string, StudentAttempts>,
): Promise<Map<string, ReleasedGrade>> {
  const released = rows.filter((row) => row.evaluation.releasedAt !== null);
  const live = released.filter(
    (row) => cachedGrade(row.evaluation, userId, countedAttemptId(retaking, row)) === null,
  );
  const tallies = await liveTallies(
    db,
    [...new Set(live.map((r) => r.evaluation.id))],
    live.map((row) => countedAttemptId(retaking, row)),
  );
  return new Map(
    released.map((row) => [
      row.evaluation.id,
      gradeShown(row.evaluation, userId, countedAttemptId(retaking, row), tallies),
    ]),
  );
}

/** What {@link gradeShown} needs of a grade that is not frozen any more. */
interface LiveTallies {
  totals: ReadonlyMap<string, number>;
  points: ReadonlyMap<string, number>;
}

/** The totals of `evaluationIds` and the points of `attemptIds`: two grouped queries. */
async function liveTallies(
  db: Db,
  evaluationIds: readonly string[],
  attemptIds: readonly (string | null)[],
): Promise<LiveTallies> {
  const [totals, points] = await Promise.all([
    totalPointsByEvaluation(db, [...evaluationIds]),
    pointsByAttempt(
      db,
      attemptIds.filter((id): id is string => id !== null),
    ),
  ]);
  return { totals, points };
}

/**
 * THE grade a student is shown for a released evaluation — the student home,
 * the results cards and `results_updated` all read it here: the frozen one
 * while it still holds (`cachedGrade`), otherwise the live one, from the
 * validated gradings of the attempt that counts.
 */
function gradeShown(
  evaluation: EvaluationRecord,
  userId: string,
  attemptId: string | null,
  live: LiveTallies,
): ReleasedGrade {
  const hit = cachedGrade(evaluation, userId, attemptId);
  if (hit) return { attemptId, ...hit };
  const totalPoints = live.totals.get(evaluation.id) ?? 0;
  const points = attemptId ? (live.points.get(attemptId) ?? 0) : 0;
  const grade = gradeFromPoints(points, totalPoints, scaleOf(evaluation));
  return { attemptId, points, totalPoints, grade };
}

/** {@link ReleasedGrade}, and whether the feedback page would show it now. */
export interface ShownGrade extends ReleasedGrade {
  visible: boolean;
}

/**
 * {@link gradeShown} for several students of ONE released evaluation, in a
 * handful of queries whatever their number (the kept attempts, the total,
 * the points): what `results_updated` compares before and after a grading
 * write. `visible` is {@link resultsState}'s `available`, so a student under
 * the policy `none`, or with no attempt, is never told of a grade they cannot
 * read.
 */
export async function shownGrades(
  db: Db,
  evaluation: EvaluationRecord,
  userIds: readonly string[],
): Promise<Map<string, ShownGrade>> {
  const kept = await keptAttempts(db, evaluation);
  const attemptOf = (userId: string) => kept.get(userId) ?? null;
  const live = userIds.filter(
    (userId) => cachedGrade(evaluation, userId, attemptOf(userId)?.id ?? null) === null,
  );
  const tallies = await liveTallies(
    db,
    live.length === 0 ? [] : [evaluation.id],
    live.map((userId) => attemptOf(userId)?.id ?? null),
  );
  return new Map(
    userIds.map((userId) => {
      const attempt = attemptOf(userId);
      return [
        userId,
        {
          ...gradeShown(evaluation, userId, attempt?.id ?? null, tallies),
          visible: resultsState(evaluation, attempt?.state ?? null) === "available",
        },
      ];
    }),
  );
}

/** `GET /student/results` — one card per released evaluation the student took. */
export async function studentResultCards(db: Db, userId: string): Promise<ResultCard[]> {
  const rows = (await studentEvaluationRows(db, userId)).filter(
    (row) => row.evaluation.releasedAt !== null,
  );
  const retaking = await studentAttempts(
    db,
    userId,
    rows.filter((row) => retakesEnabled(row.evaluation)).map((row) => row.evaluation),
  );
  const grades = await releasedGradesOf(db, userId, rows, retaking);
  return rows.map((row) => {
    const { attemptId, points, totalPoints, grade } = grades.get(row.evaluation.id)!;
    return {
      evaluationId: row.evaluation.id,
      title: row.evaluation.title,
      classroomId: classroomIdOf(row.evaluation),
      classroomName: row.classroomName,
      courseCode: row.courseCode,
      attemptId,
      releasedAt: isoOrNull(row.evaluation.releasedAt),
      points,
      totalPoints,
      grade,
    };
  });
}
