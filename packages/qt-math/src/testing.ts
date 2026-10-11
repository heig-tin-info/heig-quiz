/**
 * `@quiz/qt-math/testing` — the full configuration of the leak test
 * (invariant 4, docs/spec/05 §5.7). TEST-ONLY: nothing in `apps/*` imports it.
 */
import type { StudentLeakFixture } from "@quiz/core/testing";

import { MathConfigSchema, type MathConfig } from "./schema.js";

/** Two keys, a tolerance and a sample count of its own, a function rule: every secret a `math` config holds. */
export const SECRET_CONFIG: MathConfig = MathConfigSchema.parse({
  configVersion: 1,
  prompt: "Give the equivalent resistance of $R_1$ and $R_2$ in parallel.",
  symbols: [
    { name: "R_1", min: 1, max: 100 },
    { name: "R_2", min: 1, max: 100 },
  ],
  answers: [
    { value: "\\frac{R_1 R_2}{R_1+R_2}", points: 1 },
    { value: "R_1+R_2", points: 0.25 },
  ],
  tolerance: 0.00123,
  samples: 17,
  forbidden: ["sin"],
  maxLength: 120,
  plot: "none",
});

/** Values that must never appear in the serialised student view. */
const SECRET_VALUES = ["\\frac{R_1 R_2}{R_1+R_2}", "R_1+R_2", "0.00123", "17", "0.25"];

export const mathLeakFixture: StudentLeakFixture<MathConfig> = {
  config: SECRET_CONFIG,
  /** The key's own vocabulary: the accepted answers, their points, how they are compared. */
  forbiddenKeys: ["value", "points", "samples", "min", "max"],
  secrets: SECRET_VALUES,
};
