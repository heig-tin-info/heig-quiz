/**
 * `@quiz/qt-short/testing` — the full configuration of the leak test
 * (invariant 4, docs/spec/05 §5.7). TEST-ONLY: nothing in `apps/*` imports it.
 */
import type { StudentLeakFixture } from "@quiz/core/testing";

import { ShortConfigSchema, type ShortConfig } from "./schema.js";

/** One matcher of every kind, every secret a `short` config can hold. */
export const SECRET_CONFIG: ShortConfig = ShortConfigSchema.parse({
  configVersion: 2,
  prompt: "How many bytes does an `int` take on a 32-bit target?",
  kind: "number",
  placeholder: "bytes",
  constraints: { min: 1, max: 100, integer: true },
  prefilters: { trim: true, lowercase: false },
  matchers: [
    { kind: "exact", value: "0x1004" },
    { kind: "regex", pattern: "^N[0-9]+$", flags: "i" },
    { kind: "number", value: 4, tolerance: 0.5, toleranceMode: "abs", unit: "bytes" },
    { kind: "date", value: "1970-01-01", toleranceDays: 2 },
    { kind: "time", value: "14:05", toleranceMinutes: 5 },
    { kind: "llm", rubric: "Newton and his three laws", reference: "Isaac Newton", points: 0.5 },
  ],
});

/** Values that must never appear in the serialised student view. */
const SECRET_VALUES = [
  "0x1004",
  "^N[0-9]+$",
  "1970-01-01",
  "14:05",
  "Newton",
  "Isaac Newton",
];

export const shortLeakFixture: StudentLeakFixture<ShortConfig> = {
  config: SECRET_CONFIG,
  /*
   * The matcher's own vocabulary, which says how the answer is compared and
   * therefore what it looks like.
   */
  forbiddenKeys: [
    // Out of the floor since R-06 (only `code` publishes it, on purpose); here
    // it still names nothing this type may publish.
    "compare",
    "expected",
    "policy",
    "reference",
    "tolerance",
    "toleranceDays",
    "toleranceMinutes",
    "toleranceMode",
    "unit",
    "unitRequired",
    "value",
  ],
  secrets: SECRET_VALUES,
};
