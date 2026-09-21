/**
 * The canonical YAML mapping of a `cloze` config (docs/04 §4.2, PLAN-MVP §2.3).
 *
 * The text carries its own blanks, so the mapping is almost the identity: the
 * two switches may be omitted when they sit at their default, and the
 * predefined choice sets when the question has none.
 */
import { CLOZE_CONFIG_VERSION, ClozeConfigSchema, type ClozeChoiceSet, type ClozeConfig } from "./schema.js";

export interface ClozeCanonical {
  configVersion: number;
  text: string;
  caseSensitive?: boolean;
  shuffleOptions?: boolean;
  choiceSets?: ClozeChoiceSet[];
}

export function toCanonical(config: ClozeConfig): ClozeCanonical {
  const out: ClozeCanonical = { configVersion: CLOZE_CONFIG_VERSION, text: config.text };
  if (config.caseSensitive) out.caseSensitive = true;
  if (!config.shuffleOptions) out.shuffleOptions = false;
  if (config.choiceSets.length > 0) out.choiceSets = config.choiceSets;
  return out;
}

export function fromCanonical(raw: unknown): ClozeConfig {
  return ClozeConfigSchema.parse(raw);
}
