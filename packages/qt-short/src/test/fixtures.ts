/** Test fixtures for the `short` suites (excluded from the build). */
import { ShortConfigSchema, type ShortConfig } from "../schema.js";

export function config(over: Partial<ShortConfig> = {}): ShortConfig {
  return ShortConfigSchema.parse({
    configVersion: 3,
    prompt: "Which directive includes the standard I/O header?",
    matchers: [{ kind: "exact", value: "#include <stdio.h>" }],
    ...over,
  });
}

/** The full fixture of the leak test (`../testing.ts`), shared with the registry's contract test. */
export * from "../testing.js";
