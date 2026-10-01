/**
 * A page's front matter (F-JRN-08): the fences, the YAML block parsed, and
 * how its values are read. A module of its own, without marked nor KaTeX,
 * so that the web editor (M4-06) reads the fields exactly as the renderer
 * does (`@quiz/docrender/frontMatter`) without loading the renderer.
 */
import { CONTROL_CHAR, hasControlChar, type JournalWarning } from "@quiz/contracts";
import { YAMLParseError, parse as parseYaml } from "yaml";

/** Every control character of a string, for a replacement. */
const CONTROLS = new RegExp(CONTROL_CHAR.source, "g");

/**
 * One line of plain text: tab and line breaks become spaces, other controls
 * U+FFFD, and a lone surrogate U+FFFD too (`toWellFormed`: Postgres and JSON
 * encoders refuse half a character).
 */
export function oneLine(text: string): string {
  const whole = text.toWellFormed();
  if (!hasControlChar(whole)) return whole;
  return whole.replace(/[\t\n\r]/g, " ").replace(CONTROLS, "\ufffd");
}

/**
 * Every string of a YAML value, well formed, with its control characters
 * replaced by U+FFFD \u2014 except tab and line breaks in a value, which a
 * multi-line YAML string legitimately holds. Keys are single lines.
 */
function cleanStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return value.toWellFormed().replace(CONTROLS, (c) => ("\t\n\r".includes(c) ? c : "\ufffd"));
  }
  if (Array.isArray(value)) return value.map(cleanStrings);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [oneLine(k), cleanStrings(v)]));
  }
  return value;
}

/**
 * The front matter's fences, the one rule: `---` on the first line, the
 * block, `---` on a line of its own. Three groups (the opening fence, the
 * block, the closing fence, each as written) so that the web editor, which
 * rewrites the block line by line (M4-06), cuts the page where this
 * renderer does.
 */
export const FRONT_MATTER = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;

/**
 * Splits the `---` block off the top of a page. A block that is not a mapping
 * (a list, a bare string, broken YAML) is reported and ignored rather than
 * guessed at: the page still renders, with its file name as its title.
 */
export function splitFrontMatter(source: string): {
  frontMatter: Record<string, unknown>;
  body: string;
  warnings: JournalWarning[];
} {
  const m = FRONT_MATTER.exec(source);
  if (!m) return { frontMatter: {}, body: source, warnings: [] };
  const body = source.slice(m[0].length);
  try {
    const parsed = parseYaml(m[2]!) as unknown;
    if (parsed === null || parsed === undefined) return { frontMatter: {}, body, warnings: [] };
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return { frontMatter: {}, body, warnings: [{ code: "front_matter_not_mapping" }] };
    }
    return { frontMatter: cleanStrings(parsed) as Record<string, unknown>, body, warnings: [] };
  } catch (err) {
    // The line in the FILE: the block starts on the line after the opening `---`.
    const line = err instanceof YAMLParseError ? err.linePos?.[0].line : undefined;
    const warning: JournalWarning =
      line === undefined ? { code: "front_matter_yaml" } : { code: "front_matter_yaml", line: line + 1 };
    return { frontMatter: {}, body, warnings: [warning] };
  }
}

/** `draft: true`, `draft: "yes"`, `draft: 1` — anything a teacher may type. */
export function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return /^(true|yes|y|on|1)$/i.test(value.trim());
  return false;
}
