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
 */
export function loadConfig(type: string, row: ConfigRow): unknown {
  const t = typeOf(type);
  const migrated =
    row.configVersion === t.configVersion ? row.config : t.migrate(row.config, row.configVersion);
  return t.configSchema.parse(migrated);
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
    return { ok: true, config: loadConfig(type, row) };
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
 */
export function saveConfig(type: string, config: unknown): ConfigRow {
  const t = typeOf(type);
  return { config: t.configSchema.parse(config), configVersion: t.configVersion };
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
    return { row: saveConfig(type, raised), issues: [] };
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
    fromType = t.searchText(t.configSchema.parse(config));
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
