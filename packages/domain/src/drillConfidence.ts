/**
 * The confidence a student states on a drill card before the correction
 * (ADR-085, F-DRILL-07): 0 "No idea" to 4 "Certain", optional. It is read
 * beside the review and never by the rating or a score; it reaches the
 * schedule at one point only, the due date of a confident error
 * (`drillConfidenceDue`, ADR-085 §4 as amended 2026-10-08).
 */
import type { DrillCorrectness } from "./drillRating.js";
import { drillDayBounds } from "./drillSession.js";
import { SCHOOL_TIME_ZONE } from "./zone.js";

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

/**
 * The due date a review is written with (ADR-085 §4, amended 2026-10-08):
 * what FSRS computed, except that a confident error comes back tomorrow at
 * the latest — the earlier of FSRS's due date and the first instant of the
 * next calendar day on the drill's clock (`drillDayBounds(now).end`), the
 * instant from which tomorrow's session counts the card as due. Only the
 * due date is capped: the rating and the FSRS state stay what FSRS made.
 * A new card answered wrong is already due tomorrow; the cap moves the
 * mature ones, which Again sends days away.
 */
export function drillConfidenceDue(
  outcome: DrillConfidenceOutcome,
  fsrsDue: Date,
  now: Date,
  timeZone: string = SCHOOL_TIME_ZONE,
): Date {
  if (outcome !== "confident_error") return fsrsDue;
  const tomorrow = drillDayBounds(now, timeZone).end;
  return fsrsDue < tomorrow ? fsrsDue : tomorrow;
}
