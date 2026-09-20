/**
 * The canonical YAML mapping of an `mcq` config (docs/04 §4.2, PLAN-MVP §2.1).
 *
 * Plain objects only: the YAML codec belongs to `packages/canonical` (a later
 * work package), this module just decides WHICH fields a canonical file
 * carries. A field left at its schema default is omitted, so the file a teacher
 * reads is the example of §2.1 and not a dump of every default.
 */
import {
  MCQ_CONFIG_VERSION,
  McqConfigSchema,
  type McqConfig,
} from "./schema.js";

export interface McqCanonicalChoice {
  text: string;
  correct?: boolean;
}

export interface McqCanonical {
  configVersion: number;
  prompt: string;
  choices: McqCanonicalChoice[];
  mode?: McqConfig["mode"];
  maxSelections?: number;
  policy?: McqConfig["policy"];
  penalty?: number;
  allowNegative?: boolean;
  shuffleChoices?: boolean;
}

export function toCanonical(config: McqConfig): McqCanonical {
  const out: McqCanonical = {
    configVersion: MCQ_CONFIG_VERSION,
    prompt: config.prompt,
    choices: config.choices.map((choice) =>
      choice.correct ? { text: choice.text, correct: true } : { text: choice.text },
    ),
  };
  if (config.mode !== "single") out.mode = config.mode;
  if (config.maxSelections !== undefined) out.maxSelections = config.maxSelections;
  if (config.policy !== "all_or_nothing") out.policy = config.policy;
  if (config.penalty !== 1) out.penalty = config.penalty;
  if (config.allowNegative) out.allowNegative = true;
  if (!config.shuffleChoices) out.shuffleChoices = false;
  return out;
}

/** The defaults the writer omitted are restored by the schema itself. */
export function fromCanonical(raw: unknown): McqConfig {
  return McqConfigSchema.parse(raw);
}
