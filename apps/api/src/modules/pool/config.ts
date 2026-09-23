/**
 * The ONE read/write pipeline for a stored question configuration
 * (PLAN-MVP §1.6, quick reference §10). No other file parses a raw jsonb
 * config, and no other file decides which `configVersion` to write.
 *
 * Read  — `loadConfig` raises an old config to the type's current
 *         `configVersion` through `migrate`, then parses it.
 * Write — `saveConfig` parses and stamps the CURRENT version, so a draft is
 *         always stored at the latest shape (docs/05 §5.2).
 *
 * Drafts are the exception that shapes this module: decision D16 says an
 * invalid draft is STORED, not refused, so every entry point comes in two
 * flavours — the throwing one (publication, grading) and the `try…` one
 * (autosave, listing), which hands back `issues[]` instead.
 *
 * Two gates, not one. `configSchema` is the gate of USE — preview, try,
 * grading all parse with it. A type's `publicationIssues` adds what only a
 * question handed to students needs (a `codeimage` target that fits the
 * image, ADR-021): {@link publishConfig} and the draft's issues apply it,
 * no read ever does, so the try that fulfils such a requirement is never
 * refused for lacking it.
 */
import { issuesOf, type ZodIssueLite } from "@quiz/contracts";
import type { AnyQuestionTypeServer } from "@quiz/core/server";
import { questionType } from "@quiz/registry/server";

/** The two columns of `question_versions` that carry a configuration. */
interface ConfigRow {
  config: unknown;
  configVersion: number;
}

type ConfigOutcome =
  /** Migrated and parsed. */
  | { ok: true; config: unknown }
  /**
   * Migrated as far as it would go, NOT parsed: what an invalid draft is
   * handed back as (decision D16). `config` is at the CURRENT shape whenever
   * the migration ran, which is what keeps an invalid draft from being
   * written back at the shape it was found in — see {@link tryLoadConfig}.
   */
  | { ok: false; config: unknown; issues: ZodIssueLite[] };

/** The registered type, or `UnknownQuestionType` — never `undefined`. */
export function typeOf(type: string): AnyQuestionTypeServer {
  return questionType(type);
}

/**
 * Every read of a stored config goes through this. Throws `ZodError` when the
 * stored config does not satisfy the (possibly migrated) schema — which only
 * ever happens for a draft, and the callers that tolerate one use
 * {@link tryLoadConfig}.
 *
 * A read accepts what ANY write gate accepted, so it parses with the type's
 * keyless schema when it has one: the question of an opinion poll was
 * written without a key (`saveConfig(…, { keyOptional: true })`, ADR-014,
 * addendum 2026-09-23), and its poll, its tally and its "run again" read it
 * like any other. The gates themselves — publication, the draft issues —
 * stay on `configSchema` and still demand a key.
 */
export function loadConfig(type: string, row: ConfigRow): unknown {
  const t = typeOf(type);
  return (t.keylessConfigSchema ?? t.configSchema).parse(migrated(t, row));
}

function migrated(t: AnyQuestionTypeServer, row: ConfigRow): unknown {
  return row.configVersion === t.configVersion ? row.config : t.migrate(row.config, row.configVersion);
}

/**
 * {@link loadConfig} without the throw: for a draft, which may be invalid.
 *
 * The failing branch carries the MIGRATED config, not the stored bytes. That
 * is not a detail: `draftJson` hands this straight to the editor, the editor
 * autosaves what it was given, and `saveDraftConfig` stamps the row with the
 * CURRENT version whatever it stored. A draft that came back at its old shape
 * was therefore written back as an old shape stamped current — after which
 * nothing migrates it ever again and every parse dies on `configVersion`,
 * hiding every real issue the teacher needed to see.
 */
export function tryLoadConfig(type: string, row: ConfigRow): ConfigOutcome {
  try {
    // The STRICT schema: a draft and the version a pool previews must hold a
    // key, and the editor is told when one does not.
    const t = typeOf(type);
    return { ok: true, config: t.configSchema.parse(migrated(t, row)) };
  } catch (error) {
    return { ok: false, config: raise(typeOf(type), row.config, row.configVersion), issues: issuesOf(error) };
  }
}

/**
 * The version a configuration declares INSIDE itself. Every question type of
 * this codebase carries `configVersion` in its schema, beside the
 * `question_versions.config_version` column that says the same thing; a type
 * that does not is simply left alone here.
 */
function declaredVersion(config: unknown): number | undefined {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return undefined;
  const value = (config as { configVersion?: unknown }).configVersion;
  return typeof value === "number" ? value : undefined;
}

/**
 * `type.migrate`, made total: an invalid or unreadable config comes back
 * untouched instead of throwing. The caller is always on a path where the
 * parse is about to report what is wrong with it anyway (D16), and a
 * migration failure there would replace the real issues with its own.
 */
function raise(t: AnyQuestionTypeServer, config: unknown, fromVersion: number): unknown {
  if (fromVersion === t.configVersion) return config;
  try {
    return t.migrate(config, fromVersion);
  } catch {
    return config;
  }
}

/**
 * Every write. The config is parsed and stamped with the type's CURRENT
 * version, so a stored draft never lags behind the schema.
 *
 * `keyOptional` is the poll launcher's write and nobody else's: the type's
 * `keylessConfigSchema`, an opinion poll's question (ADR-014, addendum
 * 2026-09-23). A type without one keeps its strict schema.
 */
export function saveConfig(
  type: string,
  config: unknown,
  options: { keyOptional?: boolean } = {},
): ConfigRow {
  const t = typeOf(type);
  const schema = options.keyOptional ? (t.keylessConfigSchema ?? t.configSchema) : t.configSchema;
  return { config: schema.parse(config), configVersion: t.configVersion };
}

/**
 * Whether a parsed config holds an answer key. Always true but for the
 * keyless question of an opinion poll, which nothing grades.
 */
export function hasKey(type: string, config: unknown): boolean {
  return typeOf(type).hasKey?.(config) ?? true;
}

/**
 * What publication requires beyond the schema, as zod-like issues; empty for
 * a type without the hook. `config` must already have passed the schema.
 */
export function publicationIssuesOf(type: string, config: unknown): ZodIssueLite[] {
  const t = typeOf(type);
  return (t.publicationIssues?.(config) ?? []).map((issue) => ({
    path: issue.path.map(String),
    code: "custom",
    message: issue.message,
  }));
}

/** Thrown by {@link publishConfig}: the zod issues and the publication ones, one shape. */
export class NotPublishable extends Error {
  constructor(readonly issues: ZodIssueLite[]) {
    super("config is not publishable");
    this.name = "NotPublishable";
  }
}

/**
 * The PUBLICATION write: {@link saveConfig}, then the type's
 * `publicationIssues`. Throws {@link NotPublishable} with every issue, the
 * schema's included, so a caller has one refusal to translate.
 */
export function publishConfig(
  type: string,
  config: unknown,
  options: { keyOptional?: boolean } = {},
): ConfigRow {
  let row: ConfigRow;
  try {
    row = saveConfig(type, config, options);
  } catch (error) {
    throw new NotPublishable(issuesOf(error));
  }
  const issues = publicationIssuesOf(type, row.config);
  if (issues.length > 0) throw new NotPublishable(issues);
  return row;
}

/**
 * The autosave write (decision D16): the config is stored EXACTLY as the
 * editor sent it when it does not parse, and the issues travel back to the
 * client. A valid config still goes through `saveConfig`, so it is
 * normalized (defaults applied) like any other write.
 */
export function saveDraftConfig(
  type: string,
  config: unknown,
): { row: ConfigRow; issues: ZodIssueLite[] } {
  const t = typeOf(type);
  // The row is stamped with the CURRENT version below, valid or not, so a
  // config that declares an older one is raised FIRST. Without it the two
  // halves of the same row disagree — an old shape stored under the current
  // number — and the next read, which trusts the column, never migrates it:
  // `configVersion` then fails on every parse, and a failing literal ABORTS
  // the object, so the refinements never run and the editor is told nothing
  // about the field the teacher is actually working on.
  const raised = raise(t, config, declaredVersion(config) ?? t.configVersion);
  try {
    const row = saveConfig(type, raised);
    // Usable, and stored normalized; what publication still lacks travels
    // back with it, so the editor underlines it before the Publish button.
    return { row, issues: publicationIssuesOf(type, row.config) };
  } catch (error) {
    return { row: { config: raised, configVersion: t.configVersion }, issues: issuesOf(error) };
  }
}

/**
 * The text fed to `question_versions.search_text`, from which the database
 * generates the tsvector. Postgres cannot call `type.searchText()`, so the
 * service fills the column on every write — and an invalid draft must still
 * be findable, hence the fallback on the raw config.
 */
export function searchTextOf(type: string, internalName: string, config: unknown): string {
  let fromType = "";
  try {
    const t = typeOf(type);
    fromType = t.searchText((t.keylessConfigSchema ?? t.configSchema).parse(config));
  } catch {
    // Invalid or half-written draft: index whatever text it already holds,
    // so a teacher can find the question they left unfinished.
    fromType = plainText(config);
  }
  return `${internalName} ${fromType}`.trim().slice(0, 20_000);
}

/** Every string found in a JSON value, concatenated. Bounded by the caller. */
function plainText(value: unknown, depth = 0): string {
  if (depth > 6) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => plainText(v, depth + 1)).join(" ");
  if (value && typeof value === "object") {
    return Object.values(value)
      .map((v) => plainText(v, depth + 1))
      .join(" ");
  }
  return "";
}
