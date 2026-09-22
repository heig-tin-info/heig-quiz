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

import { GradingScale } from "./evaluation.js";
import { AttemptState } from "./live.js";
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

/** F-RES-03: the per-question view, for the correction in front of the class. */
export const AnswerDistributionEntry = z.object({
  /** Canonical choice index for `mcq`, the normalised text otherwise. */
  key: z.string(),
  label: z.string(),
  count: z.number().int(),
  correct: z.boolean().nullable(),
});
export type AnswerDistributionEntry = z.infer<typeof AnswerDistributionEntry>;

export const ByQuestion = z.object({
  item: ResultsItem,
  /** The question as a student saw it (seed 0), never the raw config. */
  student: z.unknown(),
  solution: z.unknown(),
  explanation: z.string().nullable(),
  answered: z.number().int(),
  distribution: z.array(AnswerDistributionEntry),
  /** `code` only: how many attempts passed each test case. */
  casePassRate: z.array(z.object({ name: z.string(), passed: z.number().int(), total: z.number().int() })),
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

export const StudentResults = z.object({
  available: z.literal(true),
  evaluation: z.object({
    id: z.uuid(),
    title: z.string(),
    releasedAt: z.iso.datetime().nullable(),
  }),
  attemptId: z.uuid(),
  points: z.number(),
  totalPoints: z.number(),
  grade: z.number(),
  items: z.array(StudentResultItem),
});
export type StudentResults = z.infer<typeof StudentResults>;

/**
 * Before the release — or under `feedbackPolicy.when = "none"` — the student
 * sees a reason and nothing else. No points, no answer, no key: the payload
 * carries no question content at all.
 */
export const FeedbackPending = z.object({
  available: z.literal(false),
  reason: z.enum(["results_pending", "no_feedback", "attempt_open"]),
  evaluation: z.object({ id: z.uuid(), title: z.string() }),
});
export type FeedbackPending = z.infer<typeof FeedbackPending>;

export const StudentFeedback = z.discriminatedUnion("available", [
  StudentResults,
  FeedbackPending,
]);
export type StudentFeedback = z.infer<typeof StudentFeedback>;

/** `GET /student/results` — one card per released evaluation (F-RES-04). */
export const ResultCard = z.object({
  evaluationId: z.uuid(),
  title: z.string(),
  classroomId: z.uuid(),
  classroomName: z.string(),
  courseCode: z.string(),
  attemptId: z.uuid().nullable(),
  releasedAt: z.iso.datetime().nullable(),
  points: z.number(),
  totalPoints: z.number(),
  grade: z.number(),
});
export type ResultCard = z.infer<typeof ResultCard>;
