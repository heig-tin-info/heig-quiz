/**
 * Text into Typst source, with nothing it holds able to become markup
 * (ADR-125 §2). Every user string reaches the source through one of two
 * doors: {@link typstText}, in markup, or {@link typstString}, a string
 * literal handed to a function (`raw`, `img`, a zone's labels). A string
 * literal is never parsed as markup, so it is the door for anything verbatim.
 * The few shapes both renderers write — a code block, a table, a plain
 * value — are built here, once.
 */

/**
 * Every character that may open something in Typst markup: code (`#`),
 * content (`[` `]`), strong and emphasis (`*` `_`), raw (`` ` ``), maths
 * (`$`), a label or a reference (`<` `>` `@`), an escape (`\`), a shorthand
 * (`~`, `-`, `.`), a line-start marker (`=` heading, `-` `+` lists, `/` term
 * list, `1.` enumeration) and the comment starters (`//`, `/*`). Quotes too:
 * Typst would turn them into typographic ones, and an answer is printed as
 * typed. Typst accepts a backslash before any character, so escaping one
 * that needed none changes nothing.
 */
const MARKUP = /[\\#*_`$<>@[\]~=\-+/.'"]/g;

/** Control characters but tab and line breaks: Typst has no use for them, and a NUL is no text. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** `text` as literal Typst markup: what a reader sees is what was typed. */
export function typstText(text: string): string {
  return text.replace(CONTROL, "").replace(/\r\n?/g, "\n").replace(MARKUP, (c) => `\\${c}`);
}

/** `text` on one line, as a heading, a list item or a table cell holds it. */
export const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

/** One line of literal markup. */
export const typstLine = (text: string): string => typstText(oneLine(text));

/**
 * `text` as a Typst string literal, quotes included: backslash, quote and
 * line breaks escaped, any other control character as a `\u{…}` escape.
 */
export function typstString(text: string): string {
  const body = text.replace(/[\\"\n\r\t]|[\u0000-\u001f\u007f]/g, (c) => {
    switch (c) {
      case "\\":
        return "\\\\";
      case '"':
        return '\\"';
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default:
        return `\\u{${c.charCodeAt(0).toString(16)}}`;
    }
  });
  return `"${body}"`;
}

/**
 * Plain data as a Typst value: strings, numbers, booleans, `none`, arrays
 * (a one-item array keeps its trailing comma) and dictionaries.
 */
export function typstValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return typstString(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "none";
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 1 ? `(${typstValue(value[0])},)` : `(${value.map(typstValue).join(", ")})`;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "(:)";
  return `(${entries.map(([k, v]) => `${typstString(k)}: ${typstValue(v)}`).join(", ")})`;
}

/**
 * A code block: the text as a string literal, never backtick markup, so no
 * run of backticks in an answer can close it. `lang` is cut to a word.
 */
export function rawBlock(lang: string, text: string): string {
  const tag = lang.replace(/[^\w+#-]/g, "").toLowerCase();
  return `#raw(block: true, lang: ${tag ? typstString(tag) : "none"}, ${typstString(text)})`;
}

/**
 * A table of markup cells (already escaped), its header in bold; `align`
 * per column (`auto`, `left`, `center`, `right`) when the source sets one.
 * The page setup draws its strokes.
 */
export function typstTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  align?: readonly string[],
): string {
  const columns = Math.max(1, header.length);
  const aligned = align && align.some((a) => a !== "auto") ? `, align: (${align.join(", ")}${align.length === 1 ? "," : ""})` : "";
  return [
    `#table(columns: ${columns}${aligned},`,
    `  table.header(${header.map((h) => `[#strong[${h}]]`).join(", ")}),`,
    ...rows.map((row) => `  ${row.map((c) => `[${c}]`).join(", ")},`),
    ")",
  ].join("\n");
}
