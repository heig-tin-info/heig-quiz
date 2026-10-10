/**
 * A short excerpt of what a question asks, for the model's prompt that
 * proposes a pool's description (ADR-013, amendment of 2026-10-10).
 *
 * Read from the type's STUDENT view (`toStudent`) only, never from the config
 * nor from `search_text`: that view is the one shape every type is tested to
 * keep free of its answer key (invariant 4). Of it, only the top-level
 * `prompt` (or `template`, blanks shown as `___`) and the `text` or `label`
 * of the items of its top-level lists.
 *
 * No excerpt at all, never a fallback on the raw config, when the version is
 * parameterized (ADR-056) or its type is unknown, its config does not migrate
 * or parse, or its view throws.
 */
import { questionType } from "@quiz/registry/server";

const BLANK = /⸢\d+⸣/g;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;

/** The `text` or `label` of each item of the view's top-level lists. */
function itemTexts(view: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const value of Object.values(view)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const { text, label } = item as { text?: unknown; label?: unknown };
      const said = typeof text === "string" ? text : typeof label === "string" ? label : null;
      if (said) out.push(said);
    }
  }
  return out;
}

/** The excerpt of a version, at most `max` characters; null when there is none to give. */
export function questionExcerpt(type: string, version: { config: unknown; configVersion: number; variables: unknown }, max: number): string | null {
  if (version.variables !== null && version.variables !== undefined) return null;
  let view: unknown;
  try {
    const t = questionType(type);
    const raised =
      version.configVersion === t.configVersion ? version.config : t.migrate(version.config, version.configVersion);
    const config = (t.keylessConfigSchema ?? t.configSchema).parse(raised);
    view = t.toStudent(config, { seed: 0, itemId: "excerpt", shuffle: false });
  } catch {
    return null;
  }
  if (!view || typeof view !== "object") return null;
  const fields = view as Record<string, unknown>;
  const lead = typeof fields.prompt === "string" ? fields.prompt : typeof fields.template === "string" ? fields.template : "";
  const text = [lead, ...itemTexts(fields)]
    .join(" ")
    .replace(BLANK, "___")
    .replace(IMAGE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
