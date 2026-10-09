/** Test fixtures for the `rich` suites (excluded from the build). */
import { RichConfigSchema, type RichConfig } from "../schema.js";

export function config(over: Partial<RichConfig> = {}): RichConfig {
  return RichConfigSchema.parse({
    configVersion: 1,
    prompt: "Explain why a stack overflow crashes a C program.",
    ...over,
  });
}

/** The full fixture of the leak test (`../testing.ts`), shared with the registry's contract test. */
export * from "../testing.js";
