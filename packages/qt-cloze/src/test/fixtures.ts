/** Test fixtures for the `cloze` suites (excluded from the build). */
import { CLOZE_CONFIG_VERSION, ClozeConfigSchema, type ClozeConfig } from "../schema.js";

export function config(text: string, over: Partial<ClozeConfig> = {}): ClozeConfig {
  return ClozeConfigSchema.parse({ configVersion: CLOZE_CONFIG_VERSION, text, ...over });
}

/** The full fixture of the leak test (`../testing.ts`), shared with the registry's contract test. */
export * from "../testing.js";
