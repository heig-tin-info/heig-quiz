/**
 * The canonical YAML mapping of a `cloze` config (docs/04 §4.2, PLAN-MVP §2.3).
 *
 * The text carries its own blanks, so the mapping is almost the identity: the
 * two switches may be omitted when they sit at their default.
 */
import { CLOZE_CONFIG_VERSION, ClozeConfigSchema, type ClozeConfig } from "./schema.js";

export interface ClozeCanonical {
  configVersion: number;
  text: string;
  caseSensitive?: boolean;
  shuffleOptions?: boolean;
}

export function toCanonical(config: ClozeConfig): ClozeCanonical {
  const out: ClozeCanonical = { configVersion: CLOZE_CONFIG_VERSION, text: config.text };
  if (config.caseSensitive) out.caseSensitive = true;
  if (!config.shuffleOptions) out.shuffleOptions = false;
  return out;
}

export function fromCanonical(raw: unknown): ClozeConfig {
  return ClozeConfigSchema.parse(raw);
}
