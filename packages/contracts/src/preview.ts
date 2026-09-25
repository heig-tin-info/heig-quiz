/**
 * The teacher's stateless preview of a whole evaluation (issue #75, ADR-018
 * fourth addendum).
 *
 * Four calls, all on `/app/api/evaluations/:id/preview…`, all staff-only, and
 * none of them writes a row:
 *
 *   - `POST /preview` draws a fresh seed and answers {@link EvaluationPreview}:
 *     the evaluation exactly as a student would get it under that seed;
 *   - `POST /preview/run` and `/preview/simulate` are the player's Run and
 *     Simulate buttons, with the SEED in place of an attempt;
 *   - `POST /preview/grade` takes every answer and the seed, and answers
 *     {@link PreviewCorrection}: the full correction, whatever the feedback
 *     policy says.
 *
 * The seed is the whole state of a preview. The server rebuilds the item
 * order, the shuffles and the question content from it and from the frozen
 * versions of the evaluation; nothing the browser sends about a question is
 * ever trusted (invariant 14 for code sources).
 */
import { z } from "zod";

import { GradingScale } from "./evaluation.js";
import { Verdict } from "./grading.js";
import { AttemptView, RunBody, SimulateBody } from "./live.js";

/** The seed of a preview: the range `attempts.seed` is drawn in. */
export const PreviewSeed = z.number().int().min(0).max(0x7fffffff);
export type PreviewSeed = z.infer<typeof PreviewSeed>;

/** `POST /evaluations/:id/preview` — the start of one preview. */
export const EvaluationPreview = z.object({
  /** Sent back with every run and with the final grading. */
  seed: PreviewSeed,
  /**
   * How long the preview lasts, counted by the browser from the moment it
   * receives this (`previewDurationS` in `@quiz/domain`). `null`: no clock.
   */
  durationS: z.number().int().positive().nullable(),
  /**
   * The student's own payload, built by the same `studentView` path as an
   * attempt (invariant 4). `attempt.preview` is true and `attempt.id` is a
   * placeholder: no attempt exists.
   */
  view: AttemptView,
});
export type EvaluationPreview = z.infer<typeof EvaluationPreview>;

/**
 * `GET /evaluations/:id/preview/items/:itemId` — ONE item of the evaluation as
 * a student will see it (issue #127), at the version the evaluation froze,
 * not the question's latest draft. Seed 0 and no shuffle, like the question
 * editor's own preview (decision D19): the view is stable between two opens.
 */
export const ItemPreview = z.object({
  itemId: z.uuid(),
  /** Which `Player` to mount. */
  type: z.string(),
  /** The frozen version shown: the version column of the item's row. */
  versionNumber: z.number().int(),
  points: z.number(),
  /** Built by `studentView`, the one student exit (invariant 4). */
  student: z.unknown(),
});
export type ItemPreview = z.infer<typeof ItemPreview>;

/** `POST /evaluations/:id/preview/run` — the student's Run, under a seed. */
export const PreviewRunBody = RunBody.extend({ seed: PreviewSeed });
export type PreviewRunBody = z.infer<typeof PreviewRunBody>;

/** `POST /evaluations/:id/preview/simulate` — the student's Simulate, under a seed. */
export const PreviewSimulateBody = SimulateBody.extend({ seed: PreviewSeed });
export type PreviewSimulateBody = z.infer<typeof PreviewSimulateBody>;

/**
 * `POST /evaluations/:id/preview/grade`. `answers` maps an item id to the
 * answer payload the player holds for it; an item left out was never
 * touched, and is worth zero like an absent answer row (F-GRADE-01). Each
 * payload is parsed by its type's own `answerSchema` on the server.
 */
export const PreviewGradeBody = z.object({
  seed: PreviewSeed,
  answers: z
    .record(z.uuid(), z.unknown())
    .refine((answers) => Object.keys(answers).length <= 200, "too many answers"),
});
export type PreviewGradeBody = z.infer<typeof PreviewGradeBody>;

/**
 * How one item of a preview ended:
 *   - `graded`: the type's grader settled it, the runner included;
 *   - `runner_unavailable`: it needs the runner and none answered (D14);
 *   - `llm_unavailable`: it needs an LLM (phase 2);
 *   - `answer_invalid`: the payload no longer fits the type's schema;
 *   - `grader_error`: the grader threw;
 *   - `no_key`: an opinion question — nothing to be right about (ADR-014).
 * Only `graded` carries points; the others read as "not graded" and the
 * total leaves them at zero, as the grading pass's proposals are.
 */
export const PreviewItemStatus = z.enum([
  "graded",
  "runner_unavailable",
  "llm_unavailable",
  "answer_invalid",
  "grader_error",
  "no_key",
]);
export type PreviewItemStatus = z.infer<typeof PreviewItemStatus>;

export const PreviewCorrectionItem = z.object({
  itemId: z.uuid(),
  /** 0-based rank in the order the preview was played in (the seed's order). */
  position: z.number().int(),
  type: z.string(),
  status: PreviewItemStatus,
  points: z.number().nullable(),
  maxPoints: z.number(),
  verdict: Verdict.nullable(),
  /** The question as the player showed it, same seed, same shuffle. */
  student: z.unknown(),
  answer: z.unknown().nullable(),
  /** Always present: the preview shows the full correction (issue #75). */
  solution: z.unknown().nullable(),
  explanation: z.string().nullable(),
  /** The grader's full breakdown, hidden cases included. */
  details: z.unknown().nullable(),
});
export type PreviewCorrectionItem = z.infer<typeof PreviewCorrectionItem>;

export const PreviewCorrection = z.object({
  seed: PreviewSeed,
  points: z.number(),
  totalPoints: z.number(),
  /** `gradeFromPoints` under the evaluation's own scale. */
  grade: z.number(),
  scale: GradingScale,
  /** Items that are not `graded` (and not `no_key`): the grade would move once a teacher settles them. */
  ungraded: z.number().int(),
  items: z.array(PreviewCorrectionItem),
});
export type PreviewCorrection = z.infer<typeof PreviewCorrection>;
