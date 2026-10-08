/**
 * A short excerpt of what a question asks, for a reader who must recognise
 * it without seeing it whole: the admin's sorting of the tags (ADR-081,
 * second addendum §3), and the model's prompt that will follow.
 *
 * It is read from the type's STUDENT view (`toStudent`), never from the
 * config nor from `search_text`: the student view is the one shape every
 * type is tested to keep free of its answer key (invariant 4, the leak tests
 * of each type), whereas `searchText` indexes expected answers, rubrics,
 * references and test names. Of that view it keeps the human text a student
 * reads first: the `prompt` (the `template` for `cloze`, its blanks shown as
 * `___`), then the `text` or `label` of the items of its top-level lists
 * (`mcq` choices, `categorize` columns and cards). Nothing else: a nested
 * structure (a circuit's palette, a code case) is not prose.
 *
 * This is not a student payload, so it is not the `live` module's
 * `studentView`; it lives below the modules so that any of them may excerpt
 * a question without depending on `pool` or `live`.
 *
 * No excerpt at all — never a fallback on the raw config — when the version
 * is parameterized (ADR-056: a template is never read as a config, and
 * drawing an instance for an excerpt is not worth it), or when its type is
 * unknown, its config fails to migrate or to parse, or its view throws.
 */
import { questionType } from "@quiz/registry/server";

/** A stored version, as `question_versions` holds it. */
export interface StoredContent {
  config: unknown;
  configVersion: number;
  variables: unknown;
}

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
export function questionExcerpt(type: string, version: StoredContent, max: number): string | null {
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
