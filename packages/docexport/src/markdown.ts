/**
 * The Markdown renderer (ADR-121 §1): a YAML front matter of provenance,
 * then the blocks, one blank line apart. The fixed words are the document's
 * language, `LABELS[doc.lang]`: English for a staff document, worded like
 * the CSV (ADR-121 §4), the reader's for a student's (ADR-125). A program's
 * tests are a staff document's only, and stay English.
 */
import { createHash } from "node:crypto";

import { stringify } from "yaml";

import { number, type AnswerZone, type Block, type Document, type TestLine } from "./document.js";
import { labelled, LABELS, type Labels } from "./labels.js";

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

/**
 * One line to write on. A line of bare underscores is a thematic break in
 * Markdown, so it is a code span: it reads as a field in a viewer and in
 * the source alike.
 */
const WRITING_LINE = `\`${"_".repeat(40)}\``;

/** A free frame: one blank line per this many millimetres of its height. */
const MM_PER_LINE = 8;
const MIN_FRAME_LINES = 3;

/**
 * A figure, as Markdown holds one: its alt text on an italic line (ADR-126 §1).
 * The figure itself is the PDF's.
 */
function drawingLine(alt: string): string {
  const text = oneLine(alt).replace(/[\\*_`[\]<>]/g, (c) => `\\${c}`);
  return text === "" ? "" : `*${text}*`;
}

/** A paper answer space, as plain Markdown can preview one (ADR-125; a ruled frame as a plain one, ADR-126). */
function zoneBlock(z: AnswerZone, l: Labels): string {
  switch (z.zone) {
    case "bubbles": {
      // A round bubble picks one, a square box picks several, as on the screen.
      const mark = z.multiple ? "☐" : "○";
      return (z.labels ?? []).map((label) => `${mark} ${oneLine(label)}`).join("  ");
    }
    case "lines":
      return Array.from({ length: Math.max(1, z.lines ?? 1) }, () => WRITING_LINE).join("\n\n");
    case "free": {
      const blank = Math.max(MIN_FRAME_LINES, Math.round((z.heightMm ?? 0) / MM_PER_LINE));
      return ["---", ...Array.from({ length: blank }, () => ""), "---"].join("\n");
    }
    case "name":
      return `${labelled(l, l.name, "________________")}  ${labelled(l, l.firstName, "________________")}`;
  }
}

function block(b: Block, l: Labels): string {
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
      return labelled(l, l.points, `${b.earned === null ? l.notGraded : number(b.earned)} / ${number(b.max)}`);
    case "separator":
      return "---";
    case "drawing":
      return drawingLine(b.alt);
    case "answerZone":
      return zoneBlock(b, l);
  }
}

/** The body alone: the blocks, one blank line apart, and a final newline. */
export function markdownBody(doc: Pick<Document, "lang" | "blocks">): string {
  const labels = LABELS[doc.lang];
  return `${doc.blocks.map((b) => block(b, labels)).filter((text) => text !== "").join("\n\n")}\n`;
}

/** sha256 of a text, in hex. */
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The whole file: `---`, the provenance as YAML with the body's sha256, `---`,
 * then the body. `splitFrontMatter` of `@quiz/docrender` reads it back.
 */
export function renderMarkdown(doc: Document): string {
  const body = markdownBody(doc);
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
