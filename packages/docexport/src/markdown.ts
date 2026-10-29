/**
 * The Markdown renderer (ADR-121 §1): a YAML front matter of provenance,
 * then the blocks, one blank line apart. The fixed words are English: a
 * staff document is worded like the CSV (ADR-121 §4).
 */
import { createHash } from "node:crypto";

import { stringify } from "yaml";

import type { Block, Document, TestLine } from "./document.js";

/**
 * The fence of a code block: one backtick longer than the longest run of
 * backticks in `text`, at least three, so no answer can close it early.
 */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** A heading, a list item or a table cell holds one line. */
const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

/** A table cell: one line, its pipes escaped. */
const cell = (text: string): string => oneLine(text).replaceAll("|", "\\|");

/** `2`, `1.5`: two decimals at most, as the CSV writes points. */
const number = (value: number): string => String(Math.round(value * 100) / 100);

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.map(cell).join(" | ")} |`;
  return [line(header), `|${header.map(() => "---").join("|")}|`, ...rows.map(line)].join("\n");
}

function testsBlock(lines: readonly TestLine[]): string {
  if (lines.length === 0) return "No tests.";
  const passed = lines.filter((t) => t.ok).length;
  return [
    `Tests passed: ${passed}/${lines.length}`,
    table(
      ["Test", "Visibility", "Result", "Points"],
      lines.map((t) => [t.name, t.visible ? "visible" : "hidden", t.ok ? "passed" : "failed", number(t.points)]),
    ),
  ].join("\n\n");
}

function block(b: Block): string {
  switch (b.kind) {
    case "heading":
      return `${"#".repeat(b.level)} ${oneLine(b.text)}`;
    case "markdown":
      return b.text.trim();
    case "code": {
      const fence = fenceFor(b.text);
      const lang = b.lang.replace(/[^\w+-]/g, "");
      const body = b.text.endsWith("\n") ? b.text : `${b.text}\n`;
      return `${fence}${lang}\n${body}${fence}`;
    }
    case "list":
      return b.items.map((item) => `- ${oneLine(item)}`).join("\n");
    case "table":
      return table(b.header, b.rows);
    case "tests":
      return testsBlock(b.tests);
    case "points":
      return `Points: ${b.earned === null ? "not graded" : number(b.earned)} / ${number(b.max)}`;
    case "separator":
      return "---";
  }
}

/** The body alone: the blocks, one blank line apart, and a final newline. */
export function markdownBody(blocks: readonly Block[]): string {
  return `${blocks.map(block).filter((text) => text !== "").join("\n\n")}\n`;
}

/** sha256 of a text, in hex. */
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The whole file: `---`, the provenance as YAML with the body's sha256, `---`,
 * then the body. `splitFrontMatter` of `@quiz/docrender` reads it back.
 */
export function renderMarkdown(doc: Document): string {
  const body = markdownBody(doc.blocks);
  const { kind, version, source, attempts, generatedAt, app } = doc.provenance;
  const front = stringify({
    export: { kind, format: "md", version },
    source,
    attempts,
    generatedAt,
    app,
    sha256: sha256(body),
  });
  return `---\n${front}---\n${body}`;
}
