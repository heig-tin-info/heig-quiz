/**
 * The Typst renderer (ADR-121 §7, ADR-125 §1): a {@link Document} into the
 * source of one PDF, and the assets it may draw. Pure: no file, no process,
 * no clock; the API's adapter (`apps/api/src/typst/`) loads the assets,
 * puts {@link drawable} before the source and compiles it.
 *
 * Every block kind of the tree is mapped; the fixed words are the
 * document's language, `LABELS[doc.lang]`, as the Markdown renderer words
 * them. The provenance of ADR-121 §5 goes in twice: as a `<provenance>`
 * metadata (`query(<provenance>)`) and as the PDF's own title and author.
 */
import { number, type AnswerZone, type Block, type Document, type TestLine } from "../document.js";
import { labelled, LABELS, type Labels } from "../labels.js";
import { rawBlock, typstLine, typstString, typstTable, typstText, typstValue } from "./escape.js";
import { markdownToTypst, typstContext, type AssetRef, type TypstContext } from "./markdown.js";
import { pageSetup, PREAMBLE } from "./template.js";

export interface RenderedTypst {
  /** `main.typ`, without its {@link drawable} line. */
  source: string;
  /** The images it may draw, each once: the caller copies those it can to `assets/<id>` of the compile root. */
  assets: AssetRef[];
  /** Formulas printed as their LaTeX source, for the caller's log. */
  warnings: number;
  /** Formulas converted into Typst maths: a failed compile is retried with none (`math: "raw"`). */
  formulas: number;
}

export interface TypstOptions {
  /** `raw`: every formula as its LaTeX source, the second try after a compile that failed. */
  math?: TypstContext["math"];
}

/**
 * The line the caller puts before the source: the asset ids it copied into
 * the compile root. An image of any other id prints its alt text.
 */
export const drawable = (ids: readonly string[]): string => `#let drawable = ${typstValue(ids)}\n`;

const tableOf = (header: readonly string[], rows: readonly (readonly string[])[]) =>
  typstTable(header.map(typstLine), rows.map((row) => row.map(typstLine)));

/** A program's tests: a staff document's only, English like the Markdown's. */
function testsBlock(lines: readonly TestLine[]): string {
  if (lines.length === 0) return "No tests.";
  const passed = lines.filter((t) => t.ok).length;
  return [
    `Tests passed: ${passed}/${lines.length}`,
    tableOf(
      ["Test", "Visibility", "Result", "Points"],
      lines.map((t) => [t.name, t.visible ? "visible" : "hidden", t.ok ? "passed" : "failed", number(t.points)]),
    ),
  ].join("\n\n");
}

/** The millimetres of a free frame when its type names none. */
const FREE_MM = 40;

/** `value` rounded into `[min, max]`; `fallback` when it is absent or not a finite number. */
const bounded = (value: number | undefined, min: number, max: number, fallback: number): number =>
  value !== undefined && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/** An answer space, keyed for the manifest (ADR-125 §6). */
function zoneBlock(z: AnswerZone, index: number, l: Labels): string {
  const id = typstString(z.id ?? `zone-${index}`);
  const shape = (() => {
    switch (z.zone) {
      case "bubbles":
        return `bubbles(${typstValue(z.labels ?? [])}, ${z.multiple === true})`;
      case "lines":
        // At most a page of lines, at most a page of frame: a bad value never breaks the source.
        return `lines(${bounded(z.lines, 1, 40, 1)})`;
      case "free":
        return `free(${bounded(z.heightMm, 10, 240, FREE_MM)}mm)`;
      case "name":
        return `names(${typstString(l.name)}, ${typstString(l.firstName)})`;
    }
  })();
  return `#zone(${id}, ${typstString(z.zone)}, ${shape})`;
}

function block(b: Block, l: Labels, ctx: TypstContext, zones: { n: number }): string {
  switch (b.kind) {
    case "heading":
      return `#heading(level: ${b.level})[${typstLine(b.text)}]`;
    case "markdown":
      return markdownToTypst(b.text, ctx);
    case "code":
      return rawBlock(b.lang, b.text.replace(/\n$/, ""));
    case "list":
      return b.items.length === 0 ? "" : `#list(${b.items.map((i) => `[${typstLine(i)}]`).join(", ")})`;
    case "table":
      return tableOf(b.header, b.rows);
    case "tests":
      return testsBlock(b.tests);
    case "points":
      return typstText(labelled(l, l.points, `${b.earned === null ? l.notGraded : number(b.earned)} / ${number(b.max)}`));
    case "separator":
      return "#hr";
    case "answerZone":
      return zoneBlock(b, zones.n++, l);
  }
}

/** The document's title: its first level-1 heading, else its kind. */
const titleOf = (doc: Document): string =>
  doc.blocks.find((b): b is Extract<Block, { kind: "heading" }> => b.kind === "heading" && b.level === 1)?.text ??
  doc.provenance.kind;

/** The whole `main.typ` of `doc`, but its {@link drawable} line. */
export function renderTypst(doc: Document, options: TypstOptions = {}): RenderedTypst {
  const labels = LABELS[doc.lang];
  const ctx = typstContext(options.math);
  const zones = { n: 0 };
  const body = doc.blocks
    .map((b) => block(b, labels, ctx, zones))
    .filter((s) => s !== "")
    .join("\n\n");
  const { kind, version, source, attempts, generatedAt, app } = doc.provenance;
  const provenance = typstValue({ export: { kind, format: "pdf", version }, source, attempts, generatedAt, app });
  return {
    source: [
      pageSetup(typstString(titleOf(doc).replace(/\s+/g, " ").trim()), typstString(doc.lang)),
      PREAMBLE.trim(),
      `#metadata(${provenance}) <provenance>`,
      body,
      "",
    ].join("\n\n"),
    assets: [...ctx.assets.values()],
    warnings: ctx.warnings,
    formulas: ctx.formulas,
  };
}
