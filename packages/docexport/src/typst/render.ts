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
import { number, type AnswerZone, type Block, type Document, type DrawingBlock, type TestLine } from "../document.js";
import { toSvg, type Drawing } from "../drawing.js";
import { labelled, LABELS, type Labels } from "../labels.js";
import { rawBlock, typstLine, typstString, typstTable, typstText, typstValue } from "./escape.js";
import { markdownToTypst, typstContext, type AssetRef, type TypstContext } from "./markdown.js";
import { MARGIN_MM, PAGE_MM, pageSetup, PREAMBLE } from "./template.js";

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

/** Millimetres per drawing unit when a block names no width: one CSS pixel (ADR-126 §5). */
export const PX_MM = 25.4 / 96;

/** The width of the text column. */
export const COLUMN_MM = PAGE_MM.width - 2 * MARGIN_MM;

/** The height of the page body: no figure is taller (ADR-126 §5). */
export const BODY_MM = PAGE_MM.height - 2 * MARGIN_MM;

/**
 * The printed width of `drawing`, in millimetres (ADR-126 §5): `widthMm`, else
 * one pixel per unit; never wider than the column, and narrowed so its height
 * stays within `maxHeightMm`, the page body at most.
 */
export function printedWidthMm(drawing: Drawing, widthMm?: number, maxHeightMm?: number): number {
  const [, , w, h] = drawing.viewBox;
  const maxHeight = maxHeightMm !== undefined && Number.isFinite(maxHeightMm) && maxHeightMm > 0 ? Math.min(maxHeightMm, BODY_MM) : BODY_MM;
  let width = widthMm !== undefined && Number.isFinite(widthMm) && widthMm > 0 ? widthMm : w * PX_MM;
  width = Math.min(width, COLUMN_MM, (maxHeight * w) / h);
  return Math.max(1, Math.round(width * 10) / 10);
}

/** The pitch of a frame's pattern: 4 mm when its type names none, within these bounds (ADR-126 §3). */
const PITCH_MM = { fallback: 4, min: 2, max: 20 } as const;

/**
 * A figure (ADR-126 §1–§2): its SVG inline, as a string literal the preamble's
 * `figsvg` hands to `image(bytes(…), format: "svg")` — no file, nothing in the
 * compile root. A drawing `toSvg` refuses prints its alt text.
 */
function drawingBlock(b: DrawingBlock): string {
  const svg = toSvg(b.drawing);
  if (!svg.ok) return `#emph[${typstLine(b.alt)}]`;
  return `#figsvg(${typstString(svg.svg)}, ${typstString(b.alt)}, ${printedWidthMm(b.drawing, b.widthMm, b.maxHeightMm)})`;
}

/**
 * The starter under a free frame (ADR-126 §4): greyed, at a fixed scale of
 * one pixel per unit — never shrunk, the frame clips it — so a producer that
 * sets the pitch to its grid times {@link PX_MM} stays on the printed grid;
 * absent when `toSvg` refuses it.
 */
function underlay(drawing: Drawing): string | null {
  const svg = toSvg(drawing, { greyed: true });
  return svg.ok ? `(${typstString(svg.svg)}, ${Math.round(drawing.viewBox[2] * PX_MM * 1000) / 1000})` : null;
}

/** A free frame: plain (ADR-125 §6), or ruled, with its starter (ADR-126 §3–§4). */
function freeShape(z: AnswerZone): string {
  const args = [`${bounded(z.heightMm, 10, 240, FREE_MM)}mm`];
  if (z.pattern !== undefined) {
    const pitch = Number.isFinite(z.pattern.pitchMm) ? z.pattern.pitchMm : PITCH_MM.fallback;
    args.push(`pattern: ${z.pattern.kind === "lines" ? '"lines"' : '"grid"'}`);
    args.push(`pitch: ${Math.round(Math.min(PITCH_MM.max, Math.max(PITCH_MM.min, pitch)) * 1000) / 1000}mm`);
  }
  const under = z.underlay === undefined ? null : underlay(z.underlay);
  if (under !== null) args.push(`under: ${under}`);
  return `free(${args.join(", ")})`;
}

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
        return freeShape(z);
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
    case "drawing":
      return drawingBlock(b);
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
