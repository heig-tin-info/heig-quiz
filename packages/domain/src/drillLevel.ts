/**
 * A student's level on a course concept (ADR-098, #599 step 9b): the mean
 * FSRS retrievability now of their reviewed cards on it, cut into three
 * bands, and shown only from {@link DRILL_CALIBRATION_MIN_N} cards (the one
 * threshold of F-DRILL-07 and of this level). The number itself never
 * leaves: the band and the card count are the whole answer.
 */
import { DRILL_CALIBRATION_MIN_N } from "./drillCalibration.js";
import { drillMastery, type MasteryCard } from "./drillMastery.js";

/** Below this mean retrievability a concept is "To work on". */
export const DRILL_LEVEL_GETTING_FROM = 0.7;
/** From this mean retrievability on, "Solid": the scheduler's target retention. */
export const DRILL_LEVEL_SOLID_FROM = 0.9;

export const DRILL_LEVELS = ["work", "getting", "solid"] as const;
export type DrillLevel = (typeof DRILL_LEVELS)[number];

/** The band of a mean retrievability (0 to 1). */
export function drillLevel(retrievability: number): DrillLevel {
  if (retrievability >= DRILL_LEVEL_SOLID_FROM) return "solid";
  return retrievability >= DRILL_LEVEL_GETTING_FROM ? "getting" : "work";
}

/** One course concept's line: `level` is null below the threshold ("No data yet"). */
export interface ConceptLevel {
  conceptId: string;
  cards: number;
  level: DrillLevel | null;
}

/**
 * One student's levels on `listed` (the concepts the course shows them), in
 * that order. `cards` must be that student's reviewed cards whose key they may
 * see; a card counts toward every listed concept covering one of its own
 * concepts (`coverage`), and toward nothing else: no outside bucket.
 */
export function studentConceptLevels(
  cards: readonly MasteryCard[],
  listed: readonly string[],
  coverage: ReadonlyMap<string, readonly string[]>,
): ConceptLevel[] {
  const lines = new Map(drillMastery(cards, listed, coverage).lines.map((l) => [l.conceptId, l]));
  return listed.map((conceptId) => {
    // Every listed concept has a line, evidence or not.
    const line = lines.get(conceptId)!;
    const level =
      line.retrievability !== null && line.cards >= DRILL_CALIBRATION_MIN_N ? drillLevel(line.retrievability) : null;
    return { conceptId, cards: line.cards, level };
  });
}
