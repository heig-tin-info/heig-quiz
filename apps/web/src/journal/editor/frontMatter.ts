/*
 * The front matter of a journal page as four fields (F-JRN-08): `title`,
 * `date`, `draft`, `visible_from`. The editor never sees the `---` block;
 * the page is split before it opens and joined again on save.
 *
 * The block is edited LINE BY LINE, never parsed and re-dumped: a YAML dump
 * would reorder keys, requote values and drop comments, and every one of
 * those would change a key the teacher never touched. So:
 *
 *  - a field that was not changed leaves its line exactly as it was;
 *  - a changed field rewrites its own line only (`key: value`), in place;
 *  - a field emptied (or `draft` turned off) loses its line;
 *  - a field set that had no line gets one, at the end of the block;
 *  - every other line — unknown keys, comments, nested values — is kept
 *    verbatim, in its place;
 *  - a block left with no line at all disappears, `---` fences included.
 *
 * Only a top-level `key: value` on one line is a field. A key written another
 * way (a folded `title: >` block) is shown as it reads and stays untouched
 * until the teacher changes it.
 */

import { asBoolean, FRONT_MATTER, splitFrontMatter } from "@quiz/docrender/frontMatter";

/** The fields beside the editor. Empty string (or false) means "not set". */
export interface PageFields {
  title: string;
  date: string;
  draft: boolean;
  visibleFrom: string;
}

/** The YAML key of each field. */
const KEYS = { title: "title", date: "date", draft: "draft", visibleFrom: "visible_from" } as const;

/** A page cut in two: its front matter block (without the fences) and the body the editor edits. */
export interface SplitPage {
  /** The lines between the fences, verbatim; null when the page has no front matter. */
  yaml: string | null;
  /** The opening fence as written, its newline included (`---\n`). */
  open: string;
  /** The closing fence as written, with its newline when it has one. */
  close: string;
  body: string;
}

export function splitPage(markdown: string): SplitPage {
  const m = FRONT_MATTER.exec(markdown);
  if (!m) return { yaml: null, open: "---\n", close: "\n---\n", body: markdown };
  return { yaml: m[2]!, open: m[1]!, close: m[3]!, body: markdown.slice(m[0].length) };
}

/** The page again: the block between its fences (if any is left), then the body. */
export function joinPage(page: SplitPage): string {
  if (page.yaml === null) return page.body;
  return `${page.open}${page.yaml}${page.close}${page.body}`;
}

/** The line of a top-level key. */
function findKey(lines: readonly string[], key: string): { index: number } | null {
  const re = new RegExp(`^${key}[ \\t]*:`);
  const index = lines.findIndex((line) => re.test(line));
  return index === -1 ? null : { index };
}

/**
 * A string as a YAML scalar: plain when YAML would read it back as the same
 * string, double-quoted (JSON is valid YAML) otherwise.
 */
export function yamlScalar(value: string): string {
  const plain =
    /^[^\s\-?:,[\]{}#&*!|>'"%@`][^#]*$/.test(value) &&
    !/:\s|:$|\s#|\s$/.test(value) &&
    !/^(true|false|yes|no|on|off|null|~|[-+]?[0-9.]+)$/i.test(value);
  return plain ? value : JSON.stringify(value);
}

/** A front-matter value as a field shows it: "" when absent, text otherwise. */
function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return typeof value === "object" ? "" : String(value);
}

/**
 * The four fields of a page's front matter, read as the RENDERER reads them
 * (`splitFrontMatter`, `asBoolean`): what the fields show is what the page
 * does (`draft: 1` is a draft for both). A block that does not parse reads
 * as no field at all, as it renders.
 */
export function readFields(yaml: string | null): PageFields {
  const fm = yaml === null ? {} : splitFrontMatter(`---\n${yaml}\n---\n`).frontMatter;
  return {
    title: asText(fm[KEYS.title]),
    date: asText(fm[KEYS.date]),
    draft: asBoolean(fm[KEYS.draft]),
    visibleFrom: asText(fm[KEYS.visibleFrom]),
  };
}

export const sameFields = (a: PageFields, b: PageFields): boolean =>
  a.title === b.title && a.date === b.date && a.draft === b.draft && a.visibleFrom === b.visibleFrom;

/** The front matter with `fields` written in, line by line (see the head of the file). */
export function writeFields(yaml: string | null, fields: PageFields): string | null {
  const before = readFields(yaml);
  if (sameFields(before, fields)) return yaml;
  const lines = yaml === null ? [] : yaml.split(/\r?\n/);
  const eol = yaml?.includes("\r\n") ? "\r\n" : "\n";
  for (const field of ["title", "date", "draft", "visibleFrom"] as const) {
    if (fields[field] === before[field]) continue;
    const key = KEYS[field];
    const value = fields[field];
    const line =
      value === "" || value === false ? null : `${key}: ${value === true ? "true" : yamlScalar(value as string)}`;
    const found = findKey(lines, key);
    if (found && line === null) lines.splice(found.index, 1);
    else if (found && line !== null) lines[found.index] = line;
    else if (line !== null) {
      // At the end of the block, before any trailing blank line it ends with.
      let at = lines.length;
      while (at > 0 && lines[at - 1]!.trim() === "") at -= 1;
      lines.splice(at, 0, line);
    }
  }
  if (lines.every((l) => l.trim() === "")) return null;
  return lines.join(eol);
}

/** The page with `fields` as its front matter and `body` as its text. */
export function composePage(page: SplitPage, fields: PageFields, body: string): string {
  return joinPage({ ...page, yaml: writeFields(page.yaml, fields), body });
}
