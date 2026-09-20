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
import { z } from "zod";

import type { ZodIssueLite } from "@quiz/contracts";
import type { AnyQuestionTypeServer } from "@quiz/core/server";
import { questionType } from "@quiz/registry/server";

/** The two columns of `question_versions` that carry a configuration. */
export interface ConfigRow {
  config: unknown;
  configVersion: number;
}

export type ConfigOutcome =
  | { ok: true; config: unknown }
  | { ok: false; issues: ZodIssueLite[] };

/** A zod error reduced to what the editor can underline. */
export function issuesOf(error: unknown): ZodIssueLite[] {
  if (error instanceof z.ZodError) {
    return error.issues.map((i) => ({
      path: i.path.map(String),
      code: i.code,
      message: i.message,
    }));
  }
  const message = error instanceof Error ? error.message : String(error);
  return [{ path: [], code: "invalid", message }];
}

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

/** {@link loadConfig} without the throw: for a draft, which may be invalid. */
export function tryLoadConfig(type: string, row: ConfigRow): ConfigOutcome {
  try {
    return { ok: true, config: loadConfig(type, row) };
  } catch (error) {
    return { ok: false, issues: issuesOf(error) };
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
  try {
    return { row: saveConfig(type, config), issues: [] };
  } catch (error) {
    return { row: { config, configVersion: t.configVersion }, issues: issuesOf(error) };
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
