/**
 * A student's level on a course concept (ADR-098, #599 step 9b): the mean
 * FSRS retrievability now of their reviewed cards on it, cut into three
 * bands, and shown only from {@link DRILL_LEVEL_MIN_CARDS} cards. The number
 * itself never leaves: the band and the card count are the whole answer.
 */
import { DRILL_CALIBRATION_MIN_N } from "./drillCalibration.js";
import { drillMastery, type MasteryCard } from "./drillMastery.js";

/** Reviewed cards a concept needs before it has a level: F-DRILL-07's threshold, one constant. */
export const DRILL_LEVEL_MIN_CARDS = DRILL_CALIBRATION_MIN_N;

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

/** A course concept the student may be told about. */
export interface LevelConcept {
  id: string;
  /** Only a validated concept is shown; a proposed one is raw teacher text. */
  validated: boolean;
}

/** One course concept's line: `level` is null below the threshold ("No data yet"). */
export interface ConceptLevel {
  conceptId: string;
  cards: number;
  level: DrillLevel | null;
}

/**
 * One student's levels on the course's validated concepts, in the order of
 * `listed`. `cards` must be that student's reviewed cards whose key they may
 * see; a card counts toward every listed concept covering one of its own
 * concepts (`coverage`), and toward nothing else: no outside bucket.
 */
export function studentConceptLevels(
  cards: readonly MasteryCard[],
  listed: readonly LevelConcept[],
  coverage: ReadonlyMap<string, readonly string[]>,
): ConceptLevel[] {
  const shown = listed.filter((c) => c.validated).map((c) => c.id);
  const lines = new Map(drillMastery(cards, shown, coverage).lines.map((l) => [l.conceptId, l]));
  return shown.map((conceptId) => {
    // Every shown concept has a line, evidence or not.
    const line = lines.get(conceptId)!;
    const level =
      line.retrievability !== null && line.cards >= DRILL_LEVEL_MIN_CARDS ? drillLevel(line.retrievability) : null;
    return { conceptId, cards: line.cards, level };
  });
}
