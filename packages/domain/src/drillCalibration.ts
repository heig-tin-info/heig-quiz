/**
 * What stated confidences add up to (ADR-085 §8, part 2 of issue #453):
 * the student's calibration — for each level, how often they were right —
 * and the teacher's 2×2 per question — right or wrong, sure or unsure —
 * aggregated over a classroom and hidden below a number of students.
 *
 * Both read the same input, the reviews counted by stated confidence and
 * correctness (`drill_reviews`, a GROUP BY on the server); a skipped
 * statement never enters them.
 */
import { DRILL_CONFIDENCE_LEVELS, DRILL_CONFIDENT_MIN, type DrillConfidence } from "./drillConfidence.js";
import type { DrillCorrectness } from "./drillRating.js";
import { QUESTION_STATS_MIN_N } from "./stats.js";

/** Below this many answers at a level, the student's chart says "not enough answers" instead of a rate. */
export const DRILL_CALIBRATION_MIN_N = 5;

/**
 * Below this many distinct students who stated a confidence on a question,
 * its 2×2 is not shown to the teacher: an aggregate of one or two students
 * would hand back individual statements the teacher never sees otherwise.
 * The ten of every statistic about students (N-DATA-06, ADR-038 §4).
 */
export const DRILL_CONFIDENCE_MIN_STUDENTS = QUESTION_STATS_MIN_N;

/** How many reviews were stated at one level with one correctness. */
export interface DrillConfidenceCount {
  confidence: DrillConfidence;
  correctness: DrillCorrectness;
  count: number;
}

/** One level of the calibration: the answers stated at it, and those right. */
export interface DrillCalibrationLevel {
  confidence: DrillConfidence;
  answers: number;
  right: number;
}

/**
 * The five levels, lowest first, each with its answers and the right ones;
 * a level never stated is there with zero. A partial answer counts as an
 * answer and is not right.
 */
export function drillCalibration(counts: Iterable<DrillConfidenceCount>): DrillCalibrationLevel[] {
  const levels = DRILL_CONFIDENCE_LEVELS.map((confidence) => ({ confidence, answers: 0, right: 0 }));
  for (const c of counts) {
    const level = levels[c.confidence]!;
    level.answers += c.count;
    if (c.correctness === "right") level.right += c.count;
  }
  return levels;
}

/** The share right at a level, 0 to 1; null below {@link DRILL_CALIBRATION_MIN_N} answers. */
export function drillCalibrationRate(level: Pick<DrillCalibrationLevel, "answers" | "right">): number | null {
  return level.answers >= DRILL_CALIBRATION_MIN_N ? level.right / level.answers : null;
}

/** "Sure" is Sure or Certain, the same line as a confident error (ADR-085 §3). */
export const drillConfidenceSure = (confidence: DrillConfidence) => confidence >= DRILL_CONFIDENT_MIN;

/** The teacher's 2×2: right or wrong, sure (3–4) or unsure (0–2). */
export interface DrillConfidenceSplit {
  rightSure: number;
  rightUnsure: number;
  wrongSure: number;
  wrongUnsure: number;
}

/**
 * The 2×2 of some stated reviews. A partial answer is neither right nor
 * wrong (ADR-085 §3) and is left out.
 */
export function drillConfidenceSplit(counts: Iterable<DrillConfidenceCount>): DrillConfidenceSplit {
  const split = { rightSure: 0, rightUnsure: 0, wrongSure: 0, wrongUnsure: 0 };
  for (const c of counts) {
    if (c.correctness === "partial") continue;
    const sure = drillConfidenceSure(c.confidence);
    if (c.correctness === "right") split[sure ? "rightSure" : "rightUnsure"] += c.count;
    else split[sure ? "wrongSure" : "wrongUnsure"] += c.count;
  }
  return split;
}

/** Whether a question's 2×2 may be shown: from {@link DRILL_CONFIDENCE_MIN_STUDENTS} distinct students. */
export const drillConfidenceShown = (students: number) => students >= DRILL_CONFIDENCE_MIN_STUDENTS;

/**
 * The confident errors among the wrong answers, 0 to 1: high, the wrong
 * answers come from a misconception; low, from a gap. Null with no wrong
 * answer.
 */
export function drillConfidentErrorShare(split: DrillConfidenceSplit): number | null {
  const wrong = split.wrongSure + split.wrongUnsure;
  return wrong > 0 ? split.wrongSure / wrong : null;
}
