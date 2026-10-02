/**
 * `results` route schemas (PLAN-MVP §4.6, §7.1 and §3.5).
 *
 * Two audiences again:
 *   - the TEACHER sees every row, the statistics and the CSV export
 *     (F-RES-01, F-RES-02, F-RES-03);
 *   - the STUDENT sees their own attempt, through the feedback policy, and
 *     only once the results are released (F-RES-04). `studentFeedback()` in
 *     `modules/results/service.ts` is the only place that policy is applied,
 *     and it is the second half of the content gate of docs/05 §5.7.
 */
import { z } from "zod";

import { EvaluationMode, GradingScale, RetakeKeep } from "./evaluation.js";
import { AttemptScore, AttemptState, RetakeRefusalReason } from "./live.js";
import { Verdict } from "./grading.js";

/** A student with no attempt at all still gets a row, and a 1.0 (F-RES-02). */
export const ResultRowState = z.union([z.literal("absent"), AttemptState]);
export type ResultRowState = z.infer<typeof ResultRowState>;

export const ResultRow = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  lastName: z.string(),
  firstName: z.string(),
  email: z.string(),
  attemptId: z.uuid().nullable(),
  /** Points per `evaluation_items.id`; a missing key is an ungraded item. */
  perItem: z.record(z.string(), z.number()),
  points: z.number(),
  grade: z.number(),
  durationS: z.number().int().nullable(),
  state: ResultRowState,
  /**
   * A teacher's own test attempt, taken from a staff seat (ADR-018). The row
   * is listed — the teacher wants to read their own walk — and it is in no
   * statistic, in no success rate and in no exported file.
   */
  staff: z.boolean(),
});
export type ResultRow = z.infer<typeof ResultRow>;

export const ResultsStats = z.object({
  count: z.number().int(),
  mean: z.number(),
  median: z.number(),
  stdev: z.number(),
  min: z.number(),
  max: z.number(),
  /** Buckets of 0.5 grade, from 1.0 to 6.0 (PLAN-MVP §7.6). */
  histogram: z.array(z.object({ bucket: z.number(), count: z.number().int() })),
});
export type ResultsStats = z.infer<typeof ResultsStats>;

export const ResultsItem = z.object({
  id: z.uuid(),
  position: z.number().int(),
  internalName: z.string(),
  type: z.string(),
  points: z.number(),
  /** ADR-052: a bonus item, whose points are not in `totalPoints`. */
  bonus: z.boolean(),
  /** Mean of `points / maxPoints` over the validated gradings of this item. */
  successRate: z.number().nullable(),
});
export type ResultsItem = z.infer<typeof ResultsItem>;

export const ResultsView = z.object({
  evaluationId: z.uuid(),
  title: z.string(),
  totalPoints: z.number(),
  scale: GradingScale,
  released: z.boolean(),
  releasedAt: z.iso.datetime().nullable(),
  modifiedAfterRelease: z.boolean(),
  items: z.array(ResultsItem),
  rows: z.array(ResultRow),
  stats: ResultsStats,
});
export type ResultsView = z.infer<typeof ResultsView>;

/**
 * F-RES-03: one answer group of the per-question view. Its verdict comes
 * from the validated gradings of the answers in it (ADR-033).
 */
export const AnswerDistributionEntry = z.object({
  /** Canonical choice index for `mcq`, the normalised text otherwise. */
  key: z.string(),
  /** What the class wrote; `""` for an empty answer, which the client names. */
  label: z.string(),
  count: z.number().int(),
  /** `true` or `false` when every answer of the group agrees, `null` when mixed. */
  correct: z.boolean().nullable(),
  /** The part of the question the group answers (a cloze blank's index), or `null`. */
  part: z.number().int().nullable(),
});
export type AnswerDistributionEntry = z.infer<typeof AnswerDistributionEntry>;

/**
 * How the class fared on one item, over its counted attempts: an absent
 * student is in none of them, an answer still waiting for its grading to be
 * validated is in none of them either (ADR-033).
 */
export const ItemOutcomes = z.object({
  /** Full marks. */
  correct: z.number().int(),
  /** More than zero, less than full marks. */
  partial: z.number().int(),
  /** An answer at zero points or below (ADR-026). */
  wrong: z.number().int(),
  /** No answer, or one left blank on purpose. */
  blank: z.number().int(),
});
export type ItemOutcomes = z.infer<typeof ItemOutcomes>;

/**
 * F-RES-03: the per-question view, for the correction in front of the class
 * — the Results "Questions" tab and its projection. Served once the
 * evaluation is over (`closed`, `grading`, `released`), or once the
 * correction of an open exercise is published (ADR-050); `409 not_over`
 * before.
 */
export const ByQuestion = z.object({
  item: ResultsItem,
  /**
   * The papers the debrief counts, the same on every item: one per student,
   * the kept attempt — and while the exercise is still open, finished
   * attempts only (ADR-050): "handed in so far: n". It is not the sum of
   * `outcomes`: an answer whose grading is still a proposal is in this count
   * and in no outcome (ADR-033 §2). Carried on every item because the
   * response is an array; the projection reads the first.
   */
  papers: z.number().int(),
  /**
   * A parameterized question (ADR-056 §9): every student had their own
   * numbers, so `student`, `solution` and `explanation` are the instance of
   * the EXAMPLE values (seed 0), which the debrief names as such. What was
   * written is right for one student and wrong for another, so it is not
   * grouped: `distribution` is empty, but for an mcq's ticks, grouped by
   * choice (the same formula and verdict on every paper); `outcomes` holds
   * the verdicts. Absent for a static question.
   */
  parameterized: z.boolean().optional(),
  /** The question as a student saw it (seed 0), never the raw config. */
  student: z.unknown(),
  solution: z.unknown(),
  explanation: z.string().nullable(),
  outcomes: ItemOutcomes,
  /** Every answer group, most frequent first. */
  distribution: z.array(AnswerDistributionEntry),
  /**
   * `code` only: how many attempts passed each test case. `label` is the
   * name the class may read: a hidden case reads as a student reads it
   * unless the feedback policy shows hidden case names (ADR-033).
   */
  casePassRate: z.array(
    z.object({ name: z.string(), label: z.string(), passed: z.number().int(), total: z.number().int() }),
  ),
  /** Mean of `points / maxPoints` over the attempts of `outcomes`, a blank at 0. */
  successRate: z.number().nullable(),
  avgMs: z.number().nullable(),
});
export type ByQuestion = z.infer<typeof ByQuestion>;

/** `POST /evaluations/:id/release` */
export const ReleaseBody = z.object({ confirm: z.literal(true) });
export type ReleaseBody = z.infer<typeof ReleaseBody>;

export const ReleaseResponse = z.object({
  releasedAt: z.iso.datetime().nullable(),
  rows: z.number().int(),
  released: z.boolean(),
});
export type ReleaseResponse = z.infer<typeof ReleaseResponse>;

/**
 * `POST /evaluations/:id/publish-correction` (ADR-050): an explicit teacher
 * act, irreversible, so the body says so like a release does.
 */
export const PublishCorrectionBody = z.object({ confirm: z.literal(true) });
export type PublishCorrectionBody = z.infer<typeof PublishCorrectionBody>;

/**
 * The instant it was published — the first publication's, on a repeated
 * call (idempotent) — and how many finished attempts were sent to grading.
 */
export const PublishCorrectionResponse = z.object({
  correctionPublishedAt: z.iso.datetime(),
  queued: z.number().int(),
});
export type PublishCorrectionResponse = z.infer<typeof PublishCorrectionResponse>;

/** The frozen snapshot stored in `evaluations.released_grades` (§3.5). */
export const ReleasedGrades = z.object({
  releasedAt: z.iso.datetime(),
  totalPoints: z.number(),
  scale: GradingScale,
  rows: z.array(
    z.object({
      attemptId: z.uuid().nullable(),
      userId: z.uuid(),
      points: z.number(),
      grade: z.number(),
      perItem: z.record(z.string(), z.number()),
    }),
  ),
});
export type ReleasedGrades = z.infer<typeof ReleasedGrades>;

// --- Student side ---------------------------------------------------------

export const StudentResultItem = z.object({
  itemId: z.uuid(),
  position: z.number().int(),
  /**
   * The question type id, so the client can mount the right `Review`. It is
   * not a secret — the student already saw the widget it names — and without
   * it the browser would have to guess the type from the shape of `student`
   * (deviation W10-1).
   */
  type: z.string(),
  points: z.number().nullable(),
  maxPoints: z.number(),
  /** ADR-052: a bonus question, labelled as such; its points are not in the total. */
  bonus: z.boolean(),
  verdict: Verdict.nullable(),
  /** The question as the student saw it, same seed, same shuffle. */
  student: z.unknown(),
  /** Only when `feedbackPolicy.showAnswer`. */
  answer: z.unknown().nullable(),
  /** Only when `feedbackPolicy.showKey`. */
  solution: z.unknown().nullable(),
  /** Only when `feedbackPolicy.showExplanation`. */
  explanation: z.string().nullable(),
  /** Filtered: hidden case bodies removed unless `showKey` (decision D15). */
  details: z.unknown().nullable(),
  /** Only when `feedbackPolicy.showTeacherComment`. */
  comment: z.string().nullable(),
});
export type StudentResultItem = z.infer<typeof StudentResultItem>;

/**
 * The student's retake standing on an exercise that allows several attempts
 * (F-EVAL-15, ADR-025), as the results page offers it. `refusal` is the
 * server's rule (`retakeRefusal`) evaluated now: `null` means a retake may
 * start, so the page never recomputes what the server would refuse.
 */
export const RetakeStatus = z.object({
  evaluationId: z.uuid(),
  keep: RetakeKeep,
  maxAttempts: z.number().int().nullable(),
  /** Attempts taken so far, the first included. */
  attemptCount: z.number().int(),
  refusal: RetakeRefusalReason.nullable(),
});
export type RetakeStatus = z.infer<typeof RetakeStatus>;

const StudentResults = z.object({
  available: z.literal(true),
  evaluation: z.object({
    id: z.uuid(),
    title: z.string(),
    releasedAt: z.iso.datetime().nullable(),
  }),
  attemptId: z.uuid(),
  /** The validated points: a cell still pending counts nowhere, never as 0. */
  points: z.number(),
  totalPoints: z.number(),
  /**
   * Null while a cell is pending, and on an exercise before its release —
   * points only then (`feedbackGradeShown`).
   */
  grade: z.number().nullable(),
  /** How many questions still wait for a validated grading. */
  pendingCount: z.number().int().nonnegative(),
  items: z.array(StudentResultItem),
  /**
   * While an exercise with retakes is open and its correction published
   * (ADR-050): whether another attempt may start now, as on the score-only
   * page — the correction does not end the retakes.
   */
  retake: RetakeStatus.optional(),
});
type StudentResults = z.infer<typeof StudentResults>;

/**
 * Before the release — or under `feedbackPolicy.when = "none"` — the student
 * sees a reason and nothing else. No points, no answer, no key: the payload
 * carries no question content at all.
 */
export const FeedbackPending = z.object({
  available: z.literal(false),
  /**
   * `retakes_open`: an exercise that allows several attempts is still open
   * (F-EVAL-15, ADR-025). The student reads the score of this attempt and
   * nothing else, whatever the policy says about the correction. Once the
   * evaluation is closed, or its correction published (ADR-050), the
   * feedback policy decides what is shown.
   *
   * `exam_open`: an exam not closed yet shows nothing, whatever its policy:
   * the results come after the deadline.
   */
  reason: z.enum(["results_pending", "no_feedback", "attempt_open", "retakes_open", "exam_open"]),
  evaluation: z.object({ id: z.uuid(), title: z.string() }),
  /** Only with `retakes_open`: the points of this attempt, and nothing else. */
  score: AttemptScore.optional(),
  /** Only with `retakes_open`: whether another attempt may start now, and why not. */
  retake: RetakeStatus.optional(),
});
export type FeedbackPending = z.infer<typeof FeedbackPending>;

export const StudentFeedback = z.discriminatedUnion("available", [
  StudentResults,
  FeedbackPending,
]);
export type StudentFeedback = z.infer<typeof StudentFeedback>;

/**
 * Where a row of the student's Grades page stands (F-RES-04, F-ORG-14):
 * `released` — the results are released; `withheld` — released, under the
 * feedback policy `none`: the grade is not shared; `available` — not
 * released, but the feedback page already shows them (the immediate policy,
 * a published correction, ADR-050), so the row carries indicative points and
 * no grade; `pending` — handed in, results to come; `submitted` — handed in,
 * and the feedback policy will never publish anything; `missed` — nothing
 * handed in. A `missed` row of a released evaluation still carries its
 * grade, the scale minimum (F-RES-02).
 */
export const GradeStatus = z.enum([
  "released",
  "withheld",
  "available",
  "pending",
  "submitted",
  "missed",
]);
export type GradeStatus = z.infer<typeof GradeStatus>;

/** One finished evaluation of the student's, on their Grades page. */
export const EvaluationGradeRow = z.object({
  kind: z.literal("evaluation"),
  evaluationId: z.uuid(),
  title: z.string(),
  mode: EvaluationMode,
  /** When it ended for the student: the hand-in, the close, or the evaluation's. */
  date: z.iso.datetime(),
  status: GradeStatus,
  /**
   * The attempt whose feedback page the row opens (the one that counts,
   * F-EVAL-15), only when that page has something to show; null otherwise.
   */
  feedbackAttemptId: z.uuid().nullable(),
  /**
   * The points and the Swiss grade, ONLY once the results are released and
   * the feedback policy lets the student read them — never under `none`
   * (F-RES-04). On an `available` row, the points the feedback page shows
   * for the attempt that counts, indicative, `grade` null — no grade
   * before the release — and `pendingCount`, the questions still waiting
   * for a validated grading, as on that page. Null everywhere else.
   */
  score: z
    .object({
      points: z.number(),
      totalPoints: z.number(),
      grade: z.number().nullable(),
      /** Only on an `available` row. */
      pendingCount: z.number().int().nonnegative().optional(),
    })
    .nullable(),
});
export type EvaluationGradeRow = z.infer<typeof EvaluationGradeRow>;

/**
 * One RELEASED project of the student's (F-PROJ-14, F-ORG-14; product owner,
 * 2026-10-01): no row before the release — a project's score is indicative
 * until then and lives on the project's own page (F-PROJ-15). `date` is the
 * release; `score` the final score (`totalPoints` its maximum) and its grade
 * by the project's scale.
 * Never the score's source (teacher, review, frozen), the teacher's comment
 * nor the repository (N-SEC-20): those belong to the project's student view.
 */
export const ProjectGradeRow = z.object({
  kind: z.literal("project"),
  projectId: z.uuid(),
  title: z.string(),
  date: z.iso.datetime(),
  status: z.literal("released"),
  score: z.object({ points: z.number(), totalPoints: z.number(), grade: z.number() }),
});
export type ProjectGradeRow = z.infer<typeof ProjectGradeRow>;

/** One row of the student's Grades page, whatever its kind. */
export const GradeRow = z.discriminatedUnion("kind", [EvaluationGradeRow, ProjectGradeRow]);
export type GradeRow = z.infer<typeof GradeRow>;

/** One classroom of the student's Grades page, archived ones included. */
export const GradeGroup = z.object({
  classroom: z.object({
    id: z.uuid(),
    name: z.string(),
    courseCode: z.string(),
    courseName: z.string(),
    period: z.string(),
    archived: z.boolean(),
  }),
  /** Newest first. */
  rows: z.array(GradeRow),
});
export type GradeGroup = z.infer<typeof GradeGroup>;

/**
 * `GET /student/results` — the student's finished work, by classroom, the
 * classroom of the newest row first (F-RES-04, F-ORG-14). No average (D06).
 */
export const StudentGrades = z.array(GradeGroup);
export type StudentGrades = z.infer<typeof StudentGrades>;
