/**
 * The Markdown renderer (ADR-121 §1): a YAML front matter of provenance,
 * then the blocks, one blank line apart. The fixed words are the document's
 * language, `LABELS[doc.lang]`: the requester's (ADR-121 §4, ADR-125 §7,
 * amended 2026-11-04).
 */
import { createHash } from "node:crypto";

import { stringify } from "yaml";

import { number, type AnswerZone, type Block, type Choices, type Document, type TestLine } from "./document.js";
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

function testsBlock(lines: readonly TestLine[], l: Labels): string {
  if (lines.length === 0) return l.noTests;
  const passed = lines.filter((t) => t.ok).length;
  return [
    labelled(l, l.testsPassed, `${passed}/${lines.length}`),
    table(
      [l.test, l.visibility, l.result, l.points],
      lines.map((t) => [t.name, t.visible ? l.visible : l.hidden, t.ok ? l.passed : l.failed, number(t.points)]),
    ),
  ].join("\n\n");
}

/**
 * A task list, one choice per item: `- [ ] **A.** text`, `- [x]` when
 * ticked. A choice of several lines (a code fence) goes on the lines below
 * its letter, indented into the item, never on the letter's line, where it
 * would break the fence.
 */
function choicesBlock(b: Choices): string {
  return b.items
    .map(({ label, text }, at) => {
      const head = `- [${b.checked.includes(at) ? "x" : " "}] **${oneLine(label)}.**`;
      const body = text.trim();
      if (!body.includes("\n")) return body === "" ? head : `${head} ${body}`;
      return [head, ...body.split("\n").map((line) => (line === "" ? "" : `  ${line}`))].join("\n");
    })
    .join("\n");
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

/** A paper answer space, as plain Markdown can preview one (ADR-125). */
function zoneBlock(z: AnswerZone, l: Labels): string {
  switch (z.zone) {
    case "bubbles":
      // A round bubble: one option to pick.
      return (z.labels ?? []).map((label) => `○ ${oneLine(label)}`).join("  ");
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
      return `${"#".repeat(b.level)} ${oneLine(b.text)}${b.aside === undefined ? "" : ` (${oneLine(b.aside)})`}`;
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
      return testsBlock(b.tests, l);
    case "choices":
      return choicesBlock(b);
    case "points":
      return labelled(l, l.points, `${b.earned === null ? l.notGraded : number(b.earned)} / ${number(b.max)}`);
    case "separator":
      return "---";
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
