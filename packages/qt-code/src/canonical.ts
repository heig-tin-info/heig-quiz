/**
 * Canonical YAML mapping (docs/spec/04 §4.2).
 *
 * The canonical file is what a teacher reads and edits by hand, so it carries
 * the spec's field names and nothing the schema can rebuild: `configVersion`
 * is the storage's business, and a default value is left out rather than
 * written down. Round-tripping is exact for every field a teacher can set.
 */
import { CODE_CONFIG_VERSION, CodeConfig, DEFAULT_COMPARE, DEFAULT_LIMITS } from "./schema.js";

const isSameLimits = (l: CodeConfig["limits"]): boolean =>
  l.timeMs === DEFAULT_LIMITS.timeMs &&
  l.memoryMb === DEFAULT_LIMITS.memoryMb &&
  l.outputKb === DEFAULT_LIMITS.outputKb;

const isSameCompare = (c: CodeConfig["tests"]["compare"]): boolean =>
  c.trimTrailing === DEFAULT_COMPARE.trimTrailing &&
  c.ignoreCase === DEFAULT_COMPARE.ignoreCase &&
  c.numeric === null;

/** Config → the plain object a canonical `question.yaml` holds under `config:`. */
export function toCanonical(config: CodeConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {
    prompt: config.prompt,
    language: config.language,
    template: config.template,
    action: config.action,
    runsPerMinute: config.runsPerMinute,
    tests: {
      mode: config.tests.mode,
      // A default is left out, so the common case — compare stdout, require
      // exit 0, no command line — reads as the three-field case of the spec.
      cases: config.tests.cases.map((c) => ({
        name: c.name,
        ...(c.args.length === 0 ? {} : { args: [...c.args] }),
        stdin: c.stdin,
        expected: c.expected,
        ...(c.compareStdout ? {} : { compareStdout: false }),
        ...(c.expectedExitCode === 0 ? {} : { expectedExitCode: c.expectedExitCode }),
        visible: c.visible,
        points: c.points,
        ...(c.timeMs === null ? {} : { timeMs: c.timeMs }),
      })),
      ...(isSameCompare(config.tests.compare) ? {} : { compare: config.tests.compare }),
    },
  };
  if (config.runtime !== "backend") out.runtime = config.runtime;
  if (config.cooldown !== "fixed") out.cooldown = config.cooldown;
  if (config.files.length > 0) out.files = config.files.map((f) => ({ ...f }));
  if (config.compileArgs !== "") out.compileArgs = config.compileArgs;
  if (!isSameLimits(config.limits)) out.limits = { ...config.limits };
  if (config.allOrNothing) out.allOrNothing = true;
  if (config.referenceSolution !== "") out.referenceSolution = config.referenceSolution;
  return out;
}

/** The canonical object → a validated config. Throws a `ZodError` on a bad file. */
export function fromCanonical(raw: unknown): CodeConfig {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return CodeConfig.parse({ ...source, configVersion: CODE_CONFIG_VERSION });
}
