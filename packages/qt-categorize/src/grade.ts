/**
 * `categorize` grading (docs/04 §4.13, ADR-036).
 *
 * The rules — what each policy makes of the counts, and how negative marking
 * overrides them — live in `@quiz/domain/categorizeScore` and are NOT
 * reimplemented here. This module only does three things:
 *
 *   1. resolve WHICH policy applies: the question's own, or, when it says
 *      `inherit`, the evaluation's (`GradeContext.defaults.categorize`), or
 *      `per_item` when there is no evaluation at all (the Try panel);
 *   2. read the student's answer defensively into one place per card — an
 *      unknown column or card is ignored and a card listed twice keeps its
 *      FIRST place, walking the columns in the config's order. The write path
 *      already refuses such an answer (`answerMisfit`), but a grader never
 *      trusts that a stored payload went through it;
 *   3. judge every card, count, and put the fraction on the item's scale.
 */
import type { GradeContext, GradedResult } from "@quiz/core/server";
import { categorizeFraction, DEFAULT_CATEGORIZE_SCORE_POLICY } from "@quiz/domain/categorizeScore";
import { round2 } from "@quiz/domain/round";
import { normalizePlacement } from "./placement.js";
import {
  CategorizeDefaultsSchema,
  type CategorizeAnswer,
  type CategorizeCardVerdict,
  type CategorizeConfig,
  type CategorizeDetails,
  type CategorizePolicy,
} from "./schema.js";

/** The evaluation's `categorize` entry, or `null` when absent or unreadable. */
function defaultsOf(defaults: GradeContext["defaults"] | undefined) {
  const parsed = CategorizeDefaultsSchema.safeParse(defaults?.["categorize"]);
  return parsed.success ? parsed.data : null;
}

/** The applied policy: the question's own, or the evaluation's when it says `inherit`. */
export function resolvePolicy(
  config: CategorizeConfig,
  defaults: GradeContext["defaults"] | undefined,
): CategorizePolicy {
  if (config.policy !== "inherit") return config.policy;
  return defaultsOf(defaults)?.policy ?? DEFAULT_CATEGORIZE_SCORE_POLICY;
}

/** Whether the evaluation behind `defaults` scores with negative marking (ADR-026, ADR-036). */
export function negativeMarkingFrom(defaults: GradeContext["defaults"] | undefined): boolean {
  return defaultsOf(defaults)?.negativeMarking === true;
}

/** Where one card sits: its column and its 1-based rank in it. */
export interface Place {
  column: string;
  rank: number;
}

/**
 * The student's answer as ONE place per known card (point 2 above), by the
 * one rule the board draws with too (`normalizePlacement`): unknown ids are
 * ignored and a card keeps its first place. The rank counts the cards KEPT
 * in the column, so an unknown id slipped in above a card does not push it down.
 */
export function placesOf(config: CategorizeConfig, answer: CategorizeAnswer | null): Map<string, Place> {
  const places = new Map<string, Place>();
  if (answer === null) return places;
  const placement = normalizePlacement(config.columns, config.cards, answer.columns);
  for (const [column, ids] of Object.entries(placement)) {
    ids.forEach((id, index) => places.set(id, { column, rank: index + 1 }));
  }
  return places;
}

/**
 * The key as a place per TARGET card; a distractor has none. It reads the
 * `{ id, cards }` shape the config's columns and the served solution share,
 * so the grader and the review's "Expected: …" line read one key one way.
 */
export function keyOf(columns: readonly { id: string; cards: readonly string[] }[]): Map<string, Place> {
  const key = new Map<string, Place>();
  for (const column of columns) {
    column.cards.forEach((id, index) => {
      if (!key.has(id)) key.set(id, { column: column.id, rank: index + 1 });
    });
  }
  return key;
}

export function gradeCategorize(
  config: CategorizeConfig,
  answer: CategorizeAnswer | null,
  itemPoints: number,
  defaults?: GradeContext["defaults"],
): GradedResult<CategorizeDetails> {
  const policy = resolvePolicy(config, defaults);
  const negativeMarking = negativeMarkingFrom(defaults);
  const key = keyOf(config.columns);
  const places = placesOf(config, answer);

  const counts = { T: 0, D: 0, t: 0, x: 0, p: 0 };
  const cards: CategorizeCardVerdict[] = config.cards.map((card) => {
    const expected = key.get(card.id) ?? null;
    const placed = places.get(card.id) ?? null;
    let right: boolean;
    if (expected === null) {
      counts.D += 1;
      // Left out is right only once the student placed something: an empty
      // answer scores 0, and its review must not paint the distractors green.
      right = placed === null && places.size > 0;
      if (placed !== null) counts.p += 1;
    } else {
      counts.T += 1;
      right =
        placed !== null &&
        placed.column === expected.column &&
        (!config.ordered || placed.rank === expected.rank);
      if (right) counts.t += 1;
      else if (placed !== null) counts.x += 1;
    }
    return {
      id: card.id,
      placed: placed?.column ?? null,
      ...(placed === null ? {} : { rank: placed.rank }),
      expected: expected?.column ?? null,
      ...(config.ordered && expected !== null ? { expectedRank: expected.rank } : {}),
      right,
    };
  });

  const fraction = categorizeFraction({ ...counts, k: config.columns.length, policy, negativeMarking });

  return {
    kind: "graded",
    points: round2(fraction * itemPoints),
    maxPoints: itemPoints,
    // Deterministic: nothing here needs a teacher's eyes.
    state: "validated",
    details: {
      // The APPLIED policy, `inherit` resolved, as `mcq` records it.
      policy,
      ...(negativeMarking ? { negativeMarking: true } : {}),
      ordered: config.ordered,
      cards,
      ...counts,
      fraction,
    },
  };
}
