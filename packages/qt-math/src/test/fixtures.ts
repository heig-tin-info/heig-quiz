/** Test fixtures for the `math` suites (excluded from the build). */
import { MathConfigSchema, type MathConfig } from "../schema.js";

/** A one-variable question: `2x^2 - 3`, any equivalent form accepted. */
export function config(over: Partial<MathConfig> = {}): MathConfig {
  return MathConfigSchema.parse({
    configVersion: 1,
    prompt: "Give $f(x)$, the function drawn below.",
    symbols: [{ name: "x", min: -3, max: 3 }],
    answers: [{ value: "2x^2-3" }],
    ...over,
  });
}

/** The full fixture of the leak test (`../testing.ts`), shared with the registry's contract test. */
export * from "../testing.js";
