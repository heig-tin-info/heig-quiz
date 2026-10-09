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
 *     evaluation cannot exist (docs/05 §5.3, F-RES-04);
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
import { and, asc, eq, inArray, notExists } from "drizzle-orm";

import type {
  ByQuestion,
  CardResults,
  FeedbackPolicy,
  GradingScale,
  ReleasedGrades,
  ResultRow,
  ResultsItem,
  ResultsView,
  RetakeStatus,
  ReviewItem,
  StaffCopy,
  StudentFeedback,
  StudentResultItem,
} from "@quiz/contracts";
import { AI_KEY, INSTANCE_WARNING_KEY, JUSTIFICATION_KEY } from "@quiz/contracts";
import {
  evaluationTotal,
  attemptTotal,
  correctionPublishRefusal,
  debrief,
  describe,
  feedbackGate,
  feedbackGradeShown,
  GROUPED_BY_CHOICE,
  gradeFromPoints,
  histogram,
  isDebriefOpen,
  isEvaluationOpen,
  isEvaluationOver,
  isFinishedAttempt,
  latestAttempt,
  partialRetakesOn,
  retakeRefusal,
  retakeScopeOf,
  round2,
  type AttemptTally,
  type CorrectionPublishRefusal,
  type FeedbackGate,
  type FeedbackRefusal,
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
  byId,
  cachedGrade,
  cachedGrades,
  clearRelease,
  feedbackOf,
  gradeDefaults,
  joinedItems,
  retakePolicyOf,
  retakesEnabled,
  scaleOf,
  seatsOf,
  setCorrectionPublished,
  setModifiedAfterRelease,
  setRelease,
  settingsOf,
  staffAttemptIds,
  staffRosterWithAttempt,
  studentEvaluationRows,
  totalPointsByEvaluation,
  type CachedGrade,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import { notifyMany, withdrawResultsNotifications } from "../notifications/service.js";
import {
  keptAttempts,
  pairKey,
  pointsByAttempt,
  scoreOf,
  standingsOf,
  studentAttempts,
  tallyByAttempt,
  validatedGradings,
  verdictOf,
  type GradingRecord,
  type PairKey,
  type StudentAttempts,
} from "../grading/service.js";
import { answeredBy, orderItems, purgeIntegrityJournal } from "../live/service.js";
import { solutionView, stripKeys, studentSolutionView, studentView } from "../live/studentView.js";
import { typeOf } from "../pool/config.js";
import { exampleInstance, explanationOrNull, isParameterized, itemInstance } from "../pool/service.js";

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

/** Closed, being graded or released: the rule the web reads too (`isEvaluationOver`). */
const isOver = (evaluation: EvaluationRecord): boolean => isEvaluationOver(evaluation.state);

/** The correction of this exercise was published while it ran (ADR-050). */
const correctionPublished = (evaluation: EvaluationRecord): boolean =>
  evaluation.correctionPublishedAt !== null;

/** "Publish the correction" on an exam or a poll (ADR-050): never, whatever the state. */
export class CorrectionNotAllowed extends ResultsError {
  constructor(reason: Exclude<CorrectionPublishRefusal, "not_open">) {
    super("correction_not_allowed", 422, `the correction of a ${reason} is never published early`, {
      reason,
    });
  }
}

/** …and on an exercise that is not running (not yet, or no more). */
export class CorrectionNotOpen extends ResultsError {
  constructor() {
    super("correction_not_open", 409, "only a running exercise publishes its correction early");
  }
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
  const totalPoints = evaluationTotal(items.map((i) => i.item));
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
      bonus: i.item.bonus,
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

type ReleasedListener = (db: Db, evaluation: EvaluationRecord, now: Date) => Promise<unknown>;
const releasedListeners = new Set<ReleasedListener>();

/**
 * Called after every commit of {@link releaseResults}, the first release and
 * a re-release alike. The `drill` module registers here (ADR-041 §1), so
 * that `results` never imports it. A listener that throws is logged and
 * ignored: the release has committed.
 */
export function onResultsReleased(listener: ReleasedListener): void {
  releasedListeners.add(listener);
}

/**
 * The release, in ONE transaction: the frozen snapshot and the instant are
 * written together, the state moves to `released`, and the integrity
 * journal is deleted (ADR-088; `journalPurged` counts its rows). Idempotent — releasing
 * an already released evaluation recomputes the snapshot, clears
 * `modified_after_release` and keeps the ORIGINAL `released_at`, which is the
 * date the students were told about.
 */
export async function releaseResults(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<{ releasedAt: Date; rows: number; journalPurged: number }> {
  if (!isOver(evaluation)) {
    throw new NotReleasable("an evaluation is released once it is closed");
  }
  // A poll is never released (06, row 16): it would write a grade for the
  // whole classroom under a title that is its question's internal name (#305).
  if (evaluation.mode === "poll") throw new NotReleasable("a poll is never released");
  const computed = await computeResults(db, evaluation);
  const releasedAt = evaluation.releasedAt ?? now;
  const snapshot: ReleasedGrades = {
    releasedAt: iso(releasedAt),
    totalPoints: computed.totalPoints,
    scale: computed.scale,
    // The frozen snapshot is the CLASS's grades (docs/05 §5.3); a teacher's own
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
  // ADR-088: the integrity journal has served the correction; it goes with
  // the release, in its transaction. A re-release finds nothing left.
  const journalPurged = await db.transaction(async (tx) => {
    await setRelease(tx, evaluation.id, { releasedAt, releasedGrades: snapshot }, now);
    return purgeIntegrityJournal(tx, evaluation.id);
  });
  // ADR-041 §1: an exam's questions become drill cards at the release, never
  // before — the drill module listens here. Best-effort like the
  // notification below.
  for (const listener of releasedListeners) {
    try {
      await listener(db, evaluation, now);
    } catch (err) {
      console.error(`results: a release listener of ${evaluation.id} failed`, err);
    }
  }
  // F-GRADE-09: the students are told — on the FIRST release only. A
  // re-release keeps the original `released_at`, the date they were told
  // about, and telling them twice would announce nothing new. Only a student
  // with an attempt has a feedback page to open; an absent one is not told.
  //
  // Best-effort (ADR-030 §h): the release has committed, and a notification
  // that fails is logged, never thrown at the teacher who released.
  if (evaluation.releasedAt === null) {
    try {
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
    } catch (err) {
      // The service layer has no logger (as `realtime/bus.ts`): stderr.
      console.error(`results: telling the students of the release of ${evaluation.id} failed`, err);
    }
  }
  return { releasedAt, rows: snapshot.rows.length, journalPurged };
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
  await withdrawResultsNotifications(db, evaluation.id);
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

// --- Publishing the correction of a running exercise (ADR-050) ----------

/**
 * "Publish the correction" of an exercise that still runs: the class
 * debrief opens ({@link byQuestion}) and each student's own correction
 * follows the feedback policy as if released ({@link feedbackAvailable}).
 * Irreversible, and idempotent: a second call — a double click, a colleague
 * — answers the first publication's instant and does nothing else
 * (`first: false`), as a re-release keeps the original `released_at`.
 *
 * `toGrade` lists the finished attempts nothing has graded yet, for the
 * caller to send to the grading pass: without retakes, a hand-in waited for
 * the close. From now on each hand-in is graded alone
 * (`live.gradeAtHandIn`).
 */
export async function publishCorrection(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<{ publishedAt: Date; first: boolean; toGrade: string[] }> {
  const refusal = correctionPublishRefusal(evaluation);
  if (refusal === "exam" || refusal === "poll") throw new CorrectionNotAllowed(refusal);
  if (!(await setCorrectionPublished(db, evaluation.id, now))) {
    // Published already (the first instant is the answer), or not running.
    const at = (await byId(db, evaluation.id))?.correctionPublishedAt ?? null;
    if (at === null) throw new CorrectionNotOpen();
    return { publishedAt: at, first: false, toGrade: [] };
  }
  const ungraded = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(
        eq(attempts.evaluationId, evaluation.id),
        inArray(attempts.state, ["submitted", "expired"]),
        notExists(
          db.select({ id: gradings.id }).from(gradings).where(eq(gradings.attemptId, attempts.id)),
        ),
      ),
    );
  return { publishedAt: now, first: true, toGrade: ungraded.map((a) => a.id) };
}

// --- Per-question view (F-RES-03) ----------------------------------------

/**
 * The debrief of every item — the Results "Questions" tab and its projection
 * in class (ADR-033). Only once the evaluation is over: before, a projected
 * key would reach a student still answering, or one about to retake — unless
 * the teacher published the correction of an exercise, an explicit act
 * (ADR-050). While it still runs, it counts the FINISHED papers only: the
 * kept attempt falls back to one in progress when a student has none
 * finished (ADR-025 §3), and a paper still being written is nobody's result.
 */
export async function byQuestion(db: Db, evaluation: EvaluationRecord): Promise<ByQuestion[]> {
  if (!isDebriefOpen({ state: evaluation.state, correctionPublished: correctionPublished(evaluation) })) {
    throw new NotOver("the debrief of a question waits for the close");
  }
  const items = await joinedItems(db, evaluation.id);
  const validated = await validatedGradings(db, evaluation.id);
  // The class debrief is about the CLASS: the teacher's own rehearsal is not
  // in the success rates and not in the answer distributions (ADR-018).
  const staffAttempts = await staffAttemptIds(db, evaluation);
  // One attempt per student, the one that counts (ADR-025) — handed in, while
  // the exercise is still open (ADR-050).
  const kept = await keptAttempts(db, evaluation);
  const handedIn = isOver(evaluation)
    ? kept
    : new Map([...kept].filter(([, attempt]) => isFinishedAttempt(attempt.state)));
  const counted = countedAttempts(handedIn, staffAttempts);
  const views = itemViews(items, validated, counted);
  const answerRows =
    counted.size === 0
      ? []
      : await db.select().from(answers).where(inArray(answers.attemptId, [...counted]));
  const answerOf = new Map(answerRows.map((a) => [pairKey(a.attemptId, a.itemId), a]));
  // Hidden case names reach the wall as a student would read them (ADR-033).
  const { showHiddenCaseNames } = feedbackOf(evaluation);

  return items.map((item, index) => {
    // The question as the room reads it: of a parameterized one, the example
    // instance (seed 0), which the debrief names as such — every student had
    // their own numbers. Not the template: a formula on a wall is a worked
    // solution, a cloze's template is no question the type can draw, and
    // the example is the very draw publication validated. Its answers are
    // grouped by verdict only (ADR-056 §9): "2.6" is right for one student
    // and wrong for the next, so no group by what was written holds — only
    // an mcq's ticks stay, grouped by choice: choice B is the same formula,
    // with the same verdict, on every paper.
    const parameterized = isParameterized(item.version);
    const byText = parameterized && !GROUPED_BY_CHOICE.has(item.question.type);
    const example = exampleInstance(item.question.type, item.version);
    const { version } = example;
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
      papers: counted.size,
      ...(parameterized ? { parameterized } : {}),
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
      explanation: explanationOrNull(example.explanation),
      outcomes,
      distribution: byText ? [] : distribution,
      casePassRate,
      successRate,
      avgMs: null,
    };
  });
}

// --- Student feedback (F-RES-04, docs/05 §5.7) ---------------------------

/**
 * An exercise that allows retakes, while it still takes them (ADR-025) —
 * lobby, running or paused. Until the correction is published the
 * student reads the SCORE of a finished attempt and nothing else, whatever
 * the policy says — the correction of attempt 1 would be the key of
 * attempt 2. Once the evaluation is closed the teacher's feedback policy
 * decides, unchanged: `immediate` shows the correction, `on_release` waits
 * for the release, `none` shows nothing — the score included.
 * The score is shown under `none` too: a retake without it has no point, and
 * enabling retakes is the teacher's consent to it. Once the teacher publishes
 * the correction (ADR-050) the policy applies as if released, retakes open
 * or not (`feedbackGate`); under `none` the score stays.
 */
function retakesOpen(evaluation: EvaluationRecord): boolean {
  return retakesEnabled(evaluation) && isEvaluationOpen(evaluation.state);
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
    || (retakesOpen(evaluation) && attemptState !== "in_progress" && attemptState !== "not_started");
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

/**
 * Whether a student may read their GRADE of this evaluation (F-RES-04): once
 * the results are released, and only where the feedback page would show it
 * ({@link resultsState} `available`) — never under the policy `none`. A
 * student who never began (no attempt, or one left in the lobby) reads the
 * scale minimum (`gradeShown`) under the same policy as one whose attempt
 * expired empty. The student home's card and the Grades page ask this
 * before they carry a grade.
 */
export function gradeReadable(evaluation: EvaluationRecord, attemptState: string | null): boolean {
  const began = attemptState !== null && attemptState !== "not_started";
  return (
    evaluation.releasedAt !== null &&
    resultsState(evaluation, began ? attemptState : "expired") === "available"
  );
}

/**
 * Whether the feedback policy shows THE KEY to a student whose attempt is in
 * `attemptState`, now: the rule {@link studentFeedback} applies, for the
 * drill, which never shows a key earlier than the exercise would (ADR-041
 * §13) — nor later: a published correction (ADR-050) opens both at once.
 */
export function keyShownTo(evaluation: EvaluationRecord, attemptState: string): boolean {
  const policy = feedbackOf(evaluation);
  return policy.showKey && feedbackAvailable(policy, evaluation, attemptState).ok;
}

/**
 * Whether a student may see anything at all right now: `feedbackGate`
 * (`@quiz/domain`) fed with this evaluation. A published correction
 * (ADR-050) counts as the release and lifts the score-only masking; the
 * drill's `keyShownTo` reads the same answer, so it follows by construction.
 */
function feedbackAvailable(
  policy: FeedbackPolicy,
  evaluation: EvaluationRecord,
  attemptState: string,
): FeedbackGate {
  return feedbackGate({
    when: policy.when,
    exam: evaluation.mode === "exam",
    evaluationOver: isEvaluationOver(evaluation.state),
    attemptOpen: attemptState === "in_progress" || attemptState === "not_started",
    retakesOpen: retakesOpen(evaluation),
    released: evaluation.releasedAt !== null,
    correctionPublished: correctionPublished(evaluation),
  });
}

/**
 * Whether this student may start another attempt now, and why not: the
 * server's own rule (`retakeRefusal`), the one `POST /evaluations/:id/retake`
 * applies, so the results page offers exactly what the route would accept
 * (issues #120, #121).
 *
 * ADR-090: under the scope `to_review`, how many questions of the LATEST
 * finished attempt a partial retake would ask again — and, when `viewed` is
 * that attempt, each question's standing in the student's own order
 * (`review`): an id, a rank and a word, never a point, an answer or a key.
 */
async function retakeOffer(
  db: Db,
  evaluation: EvaluationRecord,
  viewed: typeof attempts.$inferSelect,
  userId: string,
  now: Date,
): Promise<{ retake: RetakeStatus; review?: ReviewItem[] }> {
  const policy = retakePolicyOf(evaluation);
  const mine = (await studentAttempts(db, userId, [evaluation])).get(evaluation.id)?.all ?? [];
  const latest = latestAttempt(mine);
  const items = partialRetakesOn(evaluation.mode, policy) ? await joinedItems(db, evaluation.id) : [];
  const standings =
    items.length > 0 && latest !== null && isFinishedAttempt(latest.state)
      ? await standingsOf(db, items, latest.id)
      : null;
  const retake: RetakeStatus = {
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
    scope: retakeScopeOf(policy),
    toReview: standings === null ? null : standings.filter((s) => s.standing !== "acquired").length,
  };
  if (standings === null || latest?.id !== viewed.id) return { retake };
  const rank = new Map(
    orderItems(items, settingsOf(evaluation), viewed.seed, evaluation.id).map((o) => [o.item.id, o.rank]),
  );
  const review = standings
    .map((s) => ({ itemId: s.id, rank: rank.get(s.id) ?? 0, standing: s.standing }))
    .sort((a, b) => a.rank - b.rank);
  return { retake, review };
}

/**
 * One attempt's questions, each with its answer, its validated grading and
 * whatever `policy` lets through: the student's feedback reads it under the
 * evaluation's policy, the teacher's copy under {@link STAFF_POLICY}.
 */
async function reviewedItems(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: typeof attempts.$inferSelect,
  policy: FeedbackPolicy,
): Promise<Pick<StaffCopy, "points" | "totalPoints" | "grade" | "pendingCount" | "items">> {
  const items = await joinedItems(db, evaluation.id);
  const totalPoints = evaluationTotal(items.map((i) => i.item));
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
    // The student's OWN instance (ADR-056 §9): the values stored with the
    // attempt, in the statement, the key and the explanation alike.
    const instance = itemInstance(item, attempt);
    const { version } = instance;
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
      bonus: item.item.bonus,
      verdict: grading ? verdictOf(grading) : null,
      student: studentView({
        ...view,
        // With the key published, the teacher's order: the review letters
        // its choices A, B, C… as the wall, the grading table and the live
        // grid do, and the ticks follow, since an answer is canonical. With
        // the key hidden, the attempt's own order: the teacher's tends to be
        // the key's (a categorize tray typed column by column), and the
        // review has nothing to colour anyway (ADR-033, addendum 2026-10-01).
        shuffle: !policy.showKey && settings.shuffleChoices && item.question.shuffleable,
        defaults: gradeDefaults(evaluation),
      }),
      answer: policy.showAnswer ? (answer?.payload ?? null) : null,
      // The student's key: the grading criteria stay the teacher's (ADR-037).
      solution: policy.showKey ? studentSolutionView(view) : null,
      explanation:
        policy.showExplanation && instance.explanation !== ""
          ? instance.explanation
          : null,
      details: grading ? filterDetails(item.question.type, grading.details, policy) : null,
      comment: policy.showTeacherComment ? (grading?.comment ?? null) : null,
    };
  });

  // The same total as the grade table (`attemptTotal`, floored at 0 under
  // negative marking, ADR-026), over the same validated gradings. A cell
  // still pending counts nowhere — never as a 0.
  const points = attemptTotal(result.flatMap((r) => (r.points === null ? [] : [r.points])));
  // Must equal `pendingCells` (grading/kept.ts), the count of the Grades page and the card.
  const pendingCount = result.filter((r) => r.points === null).length;
  // The total is the frozen one while it still holds (D-06); the per-item
  // points above always come from the gradings, which the snapshot mirrors.
  const hit =
    attempt.userId === null ? null : cachedGrade(evaluation, attempt.userId, attempt.id);
  return {
    points: hit ? hit.points : points,
    totalPoints: hit ? hit.totalPoints : totalPoints,
    grade: hit ? hit.grade : gradeFromPoints(points, totalPoints, scaleOf(evaluation)),
    pendingCount,
    items: result,
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
  const pending = (reason: FeedbackRefusal) => ({
    available: false as const,
    reason,
    evaluation: { id: evaluation.id, title: evaluation.title },
  });
  if (!gate.ok && gate.reason !== "retakes_open") return pending(gate.reason);
  // While the exercise takes retakes, the page offers the next attempt — on
  // the score alone (ADR-025) or beside a published correction (ADR-050).
  const offer =
    attempt.userId !== null && retakesOpen(evaluation)
      ? await retakeOffer(db, evaluation, attempt, attempt.userId, now)
      : null;
  const retake = offer === null ? {} : { retake: offer.retake };
  if (!gate.ok) {
    // The points of THIS attempt, and not one item: no verdict, no answer,
    // no key (ADR-025).
    const items = await joinedItems(db, evaluation.id);
    const tally = (await tallyByAttempt(db, [attempt.id])).get(attempt.id);
    return {
      ...pending(gate.reason),
      score: scoreOf(tally, items.length, evaluationTotal(items.map((i) => i.item))),
      ...retake,
      // ADR-090: the standing of each question, under the scope `to_review`.
      ...(offer?.review === undefined ? {} : { review: offer.review }),
    };
  }

  const copy = await reviewedItems(db, evaluation, attempt, policy);
  // No grade before the release, nor while a cell is pending.
  const gradeShown = feedbackGradeShown({
    released: evaluation.releasedAt !== null,
    pendingCount: copy.pendingCount,
  });
  return {
    available: true,
    evaluation: {
      id: evaluation.id,
      title: evaluation.title,
      releasedAt: isoOrNull(evaluation.releasedAt),
    },
    attemptId: attempt.id,
    ...copy,
    grade: gradeShown ? copy.grade : null,
    ...retake,
  };
}

/** The policy that shows everything: the teacher's reading of a copy. */
const STAFF_POLICY: FeedbackPolicy = {
  when: "immediate",
  showAnswer: true,
  showKey: true,
  showExplanation: true,
  showHiddenCaseNames: true,
  showTeacherComment: true,
};

/**
 * What the teacher reads of one attempt beside the grade table: the
 * student's copy with everything shown, whatever the feedback policy and
 * before any release — the answer, the key, the explanation, the comment,
 * with the grade table's own figures. Staff only: its route loads the
 * attempt through `loadEvaluationAttempt`. It is not the live dashboard's
 * `attemptInspect` (F-DASH-05), which reads an attempt being written —
 * its journal and its answers, no grading.
 */
export async function staffCopy(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: typeof attempts.$inferSelect,
): Promise<StaffCopy> {
  return { attemptId: attempt.id, ...(await reviewedItems(db, evaluation, attempt, STAFF_POLICY)) };
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
 * whole, both layers off — but for an LLM's justification
 * (`JUSTIFICATION_KEY`) and the rest of its reply (`AI_KEY`, ADR-063),
 * which are the teacher's under every policy (ADR-045, open question 27)
 * and are stripped first, as is the warning of
 * a parameterized question served from a fallback draw
 * (`INSTANCE_WARNING_KEY`, ADR-056 §7).
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

const teacherOnlyDetailKeys = new Set([JUSTIFICATION_KEY, AI_KEY, INSTANCE_WARNING_KEY]);
const forbiddenDetailKeys = new Set([...FORBIDDEN_DETAIL_KEYS, ...teacherOnlyDetailKeys]);

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
  if (policy.showKey) return stripKeys(details, teacherOnlyDetailKeys);
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
  const released = rows
    .filter((row) => row.evaluation.releasedAt !== null)
    .map((row) => {
      const attemptId = countedAttemptId(retaking, row);
      return { evaluation: row.evaluation, attemptId, hit: cachedGrade(row.evaluation, userId, attemptId) };
    });
  const live = released.filter((row) => row.hit === null);
  const tallies = await liveTallies(
    db,
    [...new Set(live.map((r) => r.evaluation.id))],
    live.map((row) => row.attemptId),
  );
  return new Map(
    released.map((row) => [
      row.evaluation.id,
      gradeShown(row.evaluation, row.attemptId, row.hit, tallies),
    ]),
  );
}

/** What {@link gradeShown} needs of a grade that is not frozen any more. */
interface LiveTallies {
  totals: ReadonlyMap<string, number>;
  points: ReadonlyMap<string, number>;
}

/**
 * Reads the total points (`attemptTotal`) of attempts: `pointsByAttempt`,
 * the validated gradings, unless a caller has a reason to read them
 * otherwise (`results_updated`'s "before" across a regrade, `updated.ts`).
 */
export type PointsReader = (db: Db, attemptIds: readonly string[]) => Promise<Map<string, number>>;

/** The totals of `evaluationIds` and the points of `attemptIds`: two grouped queries. */
async function liveTallies(
  db: Db,
  evaluationIds: readonly string[],
  attemptIds: readonly (string | null)[],
  readPoints: PointsReader = pointsByAttempt,
): Promise<LiveTallies> {
  const [totals, points] = await Promise.all([
    totalPointsByEvaluation(db, [...evaluationIds]),
    readPoints(
      db,
      attemptIds.filter((id): id is string => id !== null),
    ),
  ]);
  return { totals, points };
}

/**
 * THE grade a student is shown for a released evaluation — the student home,
 * the results cards and `results_updated` all read it here: the frozen one
 * while it still holds (`hit`, from `cachedGrade`), otherwise the live one,
 * from the validated gradings of the attempt that counts.
 */
function gradeShown(
  evaluation: EvaluationRecord,
  attemptId: string | null,
  hit: CachedGrade | null,
  live: LiveTallies,
): ReleasedGrade {
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
 * the points) and one parse of the frozen snapshot: what `results_updated`
 * compares before and after a grading write. `visible` is
 * {@link resultsState}'s `available`, so a student under the policy `none`,
 * or with no attempt, is never told of a grade they cannot read.
 */
export async function shownGrades(
  db: Db,
  evaluation: EvaluationRecord,
  userIds: readonly string[],
  readPoints?: PointsReader,
): Promise<Map<string, ShownGrade>> {
  const kept = await keptAttempts(db, evaluation);
  const frozen = cachedGrades(evaluation);
  const students = userIds.map((userId) => {
    const attempt = kept.get(userId) ?? null;
    return { userId, attempt, hit: frozen(userId, attempt?.id ?? null) };
  });
  const live = students.filter((s) => s.hit === null);
  const tallies = await liveTallies(
    db,
    live.length === 0 ? [] : [evaluation.id],
    live.map((s) => s.attempt?.id ?? null),
    readPoints,
  );
  return new Map(
    students.map(({ userId, attempt, hit }) => [
      userId,
      {
        ...gradeShown(evaluation, attempt?.id ?? null, hit, tallies),
        visible: resultsState(evaluation, attempt?.state ?? null) === "available",
      },
    ]),
  );
}
