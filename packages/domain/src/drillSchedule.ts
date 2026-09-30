/**
 * The drill scheduler (F-DRILL-02, ADR-041 §5), imported by its own subpath
 * `@quiz/domain/drillSchedule` and not from the package's index: FSRS-5 with its default
 * weights and `DRILL_TARGET_RETENTION`, computed by the `ts-fsrs` library
 * and wrapped here so that nothing else in the codebase sees it.
 *
 * The card is exactly what `drill_cards` stores (docs/spec/05 §5.4): no
 * learning steps, no fuzz — a drill is one review per card per day at most,
 * so the long-term scheduler is the whole model, and the same review always
 * yields the same due date.
 */
import { createEmptyCard, fsrs, State, type Card, type Grade } from "ts-fsrs";

import { DRILL_TARGET_RETENTION } from "./drillSession.js";

/** FSRS recall rating: 1 Again, 2 Hard, 3 Good, 4 Easy. */
export type DrillRating = 1 | 2 | 3 | 4;

/** The FSRS state of one card, as `drill_cards` stores it. */
export interface DrillCard {
  /** Days for the retrievability to fall to 90 %; 0 on a card never reviewed. */
  stability: number;
  /** 1 (easy) to 10 (hard); 0 on a card never reviewed. */
  difficulty: number;
  dueAt: Date;
  /** Null on a card never reviewed: it is NEW. */
  lastReviewAt: Date | null;
  reps: number;
  lapses: number;
}


/**
 * The 19 default weights of FSRS-5, followed by the two that make the
 * library's FSRS-6 behave as FSRS-5. Re-optimised weights replace this
 * array and nothing else.
 */
export const DRILL_FSRS_WEIGHTS: readonly number[] = Object.freeze([
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605,
  2.2698, 0.2315, 2.9898, 0.51655, 0.6621, 0, 0.5,
]);

const scheduler = fsrs({
  w: [...DRILL_FSRS_WEIGHTS],
  request_retention: DRILL_TARGET_RETENTION,
  enable_fuzz: false,
  enable_short_term: false,
});

/** A card that was never reviewed, due at once. */
export function newDrillCard(now: Date): DrillCard {
  return { stability: 0, difficulty: 0, dueAt: now, lastReviewAt: null, reps: 0, lapses: 0 };
}

export const isNewDrillCard = (card: DrillCard): boolean => card.lastReviewAt === null;

function toLibrary(card: DrillCard, now: Date): Card {
  if (isNewDrillCard(card)) return createEmptyCard(now);
  return {
    due: card.dueAt,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: card.reps,
    lapses: card.lapses,
    state: State.Review,
    last_review: card.lastReviewAt!,
  };
}

/** The card after a review rated `rating` at the server's `now`. */
export function reviewDrillCard(card: DrillCard, rating: DrillRating, now: Date): DrillCard {
  const next = scheduler.next(toLibrary(card, now), now, rating as Grade).card;
  return {
    stability: next.stability,
    difficulty: next.difficulty,
    dueAt: next.due,
    lastReviewAt: now,
    reps: next.reps,
    lapses: next.lapses,
  };
}

/** The probability, 0 to 1, that the student still recalls the card at `now`; 0 for a new card. */
export function drillRetrievability(card: DrillCard, now: Date): number {
  if (isNewDrillCard(card)) return 0;
  return scheduler.get_retrievability(toLibrary(card, now), now, false);
}
