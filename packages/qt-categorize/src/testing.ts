/**
 * `@quiz/qt-categorize/testing` — the full configuration of the leak test
 * (invariant 4, docs/spec/05 §5.7). TEST-ONLY: nothing in `apps/*` imports it.
 */
import type { StudentLeakFixture } from "@quiz/core/testing";

import { CategorizeConfigSchema, type CategorizeConfig } from "./schema.js";

/**
 * A config whose key is recognisable: the cards are written in an order
 * that is NOT the key's, so a leak of the key order is not mistaken for the
 * teacher's order, and the policy is a value of its own.
 */
export const SECRET_CONFIG: CategorizeConfig = CategorizeConfigSchema.parse({
  configVersion: 1,
  prompt: "Sort each C type by what it represents.",
  cards: [
    { id: "sec8", text: "eight" },
    { id: "sec1", text: "one" },
    { id: "sec5", text: "five" },
    { id: "sec2", text: "two" },
    { id: "sec9", text: "nine (distractor)" },
    { id: "sec4", text: "four" },
  ],
  columns: [
    { id: "cola", label: "Small", cards: ["sec1", "sec2"] },
    { id: "colb", label: "Middle", cards: ["sec4", "sec5"] },
    { id: "colc", label: "Large", cards: ["sec8"] },
  ],
  ordered: true,
  policy: "all_or_nothing",
  shuffleCards: false,
});

/**
 * The key of a `categorize` question is not a value hidden in a field: it is
 * WHICH card each column lists, and in what order. So the secrets are the key
 * arrays themselves, as they would serialize, and the scoring policy.
 */
export const categorizeLeakFixture: StudentLeakFixture<CategorizeConfig> = {
  config: SECRET_CONFIG,
  forbiddenKeys: ["compare", "policy", "expected", "expectedRank"],
  secrets: [
    ...SECRET_CONFIG.columns.map((column) => JSON.stringify(column.cards)),
    "all_or_nothing",
    "per_item",
    "inherit",
  ],
};
