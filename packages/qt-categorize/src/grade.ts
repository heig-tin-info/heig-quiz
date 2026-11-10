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
import type { AcceptedAnswer, GradeContext, GradedResult } from "@quiz/core/server";
import {
  categorizeCounts,
  categorizeFraction,
  categorizePlaceIdentity,
  DEFAULT_CATEGORIZE_SCORE_POLICY,
} from "@quiz/domain/categorizeScore";
import { round2 } from "@quiz/domain/round";
import { keyOf, placesOf } from "./placement.js";
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

export function gradeCategorize(
  config: CategorizeConfig,
  answer: CategorizeAnswer | null,
  itemPoints: number,
  defaults?: GradeContext["defaults"],
  /** The answers accepted at grading time (ADR-128): a card id, and where the student put it. */
  accepted: readonly AcceptedAnswer[] = [],
): GradedResult<CategorizeDetails> {
  const policy = resolvePolicy(config, defaults);
  const negativeMarking = negativeMarkingFrom(defaults);
  const key = keyOf(config.columns);
  const places = placesOf(config, answer);
  const acceptedAt = new Set(accepted.map((a) => `${a.part}\u0000${a.answer}`));

  const outcomes = config.cards.map((card) => {
    const expected = key.get(card.id) ?? null;
    const placed = places.get(card.id) ?? null;
    const right =
      expected === null
        ? // Left out is right only once the student placed something: an empty
          // answer scores 0, and its review must not paint the distractors green.
          placed === null && places.size > 0
        : placed !== null && placed.column === expected.column && (!config.ordered || placed.rank === expected.rank);
    // A card is accepted where the student PUT it: never one left in the tray.
    const isAccepted =
      !right && placed !== null && acceptedAt.has(`${card.id}\u0000${categorizePlaceIdentity(placed, config.ordered)}`);
    return { card, expected, placed, right, accepted: isAccepted };
  });
  // The counts are the domain's, an accepted card a right target (ADR-128).
  const counts = categorizeCounts(
    outcomes.map((o) => ({ target: o.expected !== null, placed: o.placed !== null, right: o.right, accepted: o.accepted })),
  );
  const cards: CategorizeCardVerdict[] = outcomes.map(({ card, expected, placed, right, accepted: isAccepted }) => ({
    id: card.id,
    placed: placed?.column ?? null,
    ...(placed === null ? {} : { rank: placed.rank }),
    expected: expected?.column ?? null,
    ...(config.ordered && expected !== null ? { expectedRank: expected.rank } : {}),
    right: right || isAccepted,
    ...(isAccepted ? { accepted: true as const } : {}),
  }));

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
