/**
 * The confidence a student states on a drill card before the correction
 * (ADR-085, F-DRILL-07): 0 "No idea" to 4 "Certain", optional. It is read
 * beside the review and never by the rating, the schedule or a score.
 */
import type { DrillCorrectness } from "./drillRating.js";

/** 0 No idea, 1 Unsure, 2 Fairly sure, 3 Sure, 4 Certain. */
export type DrillConfidence = 0 | 1 | 2 | 3 | 4;

/** The scale, lowest first: what the control lists and the check constraint bounds. */
export const DRILL_CONFIDENCE_LEVELS: readonly DrillConfidence[] = Object.freeze([0, 1, 2, 3, 4]);

/** From this level a statement is "sure" (Sure, Certain): a wrong answer at it is a confident error. */
export const DRILL_CONFIDENT_MIN: DrillConfidence = 3;

/**
 * What a stated confidence says about one review (ADR-085 §3):
 *   - `confident_error`: wrong, and sure or certain — the correction is
 *     highlighted ("You were sure: look closely");
 *   - `lucky`: right with no idea at all — counted as luck, never upgraded;
 *   - `calibrated`: anything else that was stated; nothing to point out;
 *   - `unstated`: the student skipped the question.
 *
 * A partial answer is neither an error nor a success: it is never a
 * confident error nor lucky.
 */
export type DrillConfidenceOutcome = "confident_error" | "lucky" | "calibrated" | "unstated";

export function drillConfidenceOutcome(
  correctness: DrillCorrectness,
  confidence: DrillConfidence | null,
): DrillConfidenceOutcome {
  if (confidence === null) return "unstated";
  if (correctness === "wrong" && confidence >= DRILL_CONFIDENT_MIN) return "confident_error";
  if (correctness === "right" && confidence === 0) return "lucky";
  return "calibrated";
}
