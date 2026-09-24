/**
 * Canonical YAML mapping of a `codeimage` question (docs/spec/04 §4.2).
 *
 * The program half reads exactly like `code`'s — same field names, same
 * defaults left out — and the image half is three plain fields and the
 * target in its compact encoding, one string a teacher can diff.
 */
import { DEFAULT_LIMITS } from "../schema.js";
import { CODEIMAGE_CONFIG_VERSION, CodeImageConfig, DEFAULT_IMAGE_LIMITS } from "./schema.js";

const isDefaultLimits = (l: CodeImageConfig["limits"]): boolean =>
  l.timeMs === DEFAULT_LIMITS.timeMs &&
  l.memoryMb === DEFAULT_LIMITS.memoryMb &&
  l.outputKb === DEFAULT_IMAGE_LIMITS.outputKb;

/** Config → the plain object a canonical `question.yaml` holds under `config:`. */
export function toCanonicalImage(config: CodeImageConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {
    prompt: config.prompt,
    language: config.language,
    template: config.template,
    runsPerMinute: config.runsPerMinute,
    image: { ...config.image },
    target: config.target === null ? null : { ...config.target },
  };
  if (config.runtime !== "backend") out.runtime = config.runtime;
  if (config.cooldown !== "fixed") out.cooldown = config.cooldown;
  if (config.files.length > 0) out.files = config.files.map((f) => ({ ...f }));
  if (config.compileArgs !== "") out.compileArgs = config.compileArgs;
  if (!isDefaultLimits(config.limits)) out.limits = { ...config.limits };
  if (config.referenceSolution !== "") out.referenceSolution = config.referenceSolution;
  return out;
}

/** The canonical object → a validated config. Throws a `ZodError` on a bad file. */
export function fromCanonicalImage(raw: unknown): CodeImageConfig {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return CodeImageConfig.parse({ ...source, configVersion: CODEIMAGE_CONFIG_VERSION });
}
