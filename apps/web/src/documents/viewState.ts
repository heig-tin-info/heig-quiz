/**
 * The pure parts of the document viewer: the zoom ladders, the page field,
 * and the reading state a host keeps between two mounts of a viewer.
 *
 * The state is what the student set and where they were, in units that do
 * not depend on the viewer's width: a PDF destination (page, and a point of
 * it in PDF units), a Markdown block and the fraction of it scrolled past.
 * So a viewer mounted again at another width — a full screen, a narrower
 * panel, a reload — puts the same passage back on top. The host may keep it
 * anywhere (PR3 keeps it per attempt in `sessionStorage`), so what comes back
 * is read through {@link readViewState}, which never trusts its shape.
 */

export type DocumentKind = "pdf" | "markdown";

/** A point of a PDF page, in PDF units (pdf.js's `XYZ` destination). */
export interface PdfLocation {
  pageNumber: number;
  top: number | null;
  left: number | null;
}

/** The first Markdown block not yet scrolled past, and how far into it the top of the view is. */
export interface MarkdownAnchor {
  block: number;
  fraction: number;
}

/** `page-width` follows the viewer's width; a number is a fixed scale. */
export type PdfScale = "page-width" | number;

export interface PdfViewState {
  kind: "pdf";
  location: PdfLocation | null;
  scale: PdfScale;
  query: string;
  outline: boolean;
}

export interface MarkdownViewState {
  kind: "markdown";
  anchor: MarkdownAnchor | null;
  /** The text size, 1 being the journal's. */
  zoom: number;
  query: string;
  outline: boolean;
}

export type DocumentViewState = PdfViewState | MarkdownViewState;

/** The scales a PDF steps through; fit-width may land between two of them. */
export const PDF_ZOOMS = [0.5, 0.67, 0.75, 0.85, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
/** The text sizes of a Markdown document. */
export const MARKDOWN_ZOOMS = [0.85, 1, 1.15, 1.3, 1.5, 1.75] as const;

/** A search query longer than this is cut: nobody types it, and a stored one is not trusted. */
export const MAX_QUERY = 200;

const EPSILON = 0.001;

/** One step along `ladder` from `current` (which may sit between two rungs), towards `dir`. */
export function zoomStep(ladder: readonly number[], current: number, dir: 1 | -1): number {
  if (dir > 0) return ladder.find((z) => z > current + EPSILON) ?? ladder[ladder.length - 1]!;
  return [...ladder].reverse().find((z) => z < current - EPSILON) ?? ladder[0]!;
}

/** Whether a step towards `dir` changes anything. */
export function canZoom(ladder: readonly number[], current: number, dir: 1 | -1): boolean {
  return dir > 0 ? current < ladder[ladder.length - 1]! - EPSILON : current > ladder[0]! + EPSILON;
}

/**
 * The page the page field asks for: a whole number, clamped to the document
 * ("0" is page 1, "99" of 12 is page 12), or null for anything that is not a
 * number (the field then shows the current page again).
 */
export function parsePageInput(text: string, pageCount: number): number | null {
  if (pageCount < 1) return null;
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Math.min(Math.max(1, Number.parseInt(trimmed, 10)), pageCount);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function readQuery(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_QUERY) : "";
}

function readLocation(value: unknown): PdfLocation | null {
  if (!isRecord(value) || !finite(value["pageNumber"]) || value["pageNumber"] < 1) return null;
  const coordinate = (v: unknown) => (finite(v) ? v : null);
  return { pageNumber: Math.floor(value["pageNumber"]), top: coordinate(value["top"]), left: coordinate(value["left"]) };
}

function readAnchor(value: unknown): MarkdownAnchor | null {
  if (!isRecord(value) || !finite(value["block"]) || !finite(value["fraction"]) || value["block"] < 0) return null;
  // Negative above the first block (the article's top padding); at most the whole block.
  return { block: Math.floor(value["block"]), fraction: clamp(value["fraction"], -1, 1) };
}

/** The state a viewer starts from when nothing was kept. */
export function initialViewState(kind: DocumentKind): DocumentViewState {
  return kind === "pdf"
    ? { kind, location: null, scale: "page-width", query: "", outline: false }
    : { kind, anchor: null, zoom: 1, query: "", outline: false };
}

/**
 * A kept state, read back for a document of `kind`: every field checked and
 * clamped, anything missing or malformed replaced by its default. A state of
 * the other kind is ignored entirely.
 */
export function readViewState(kind: DocumentKind, raw: unknown): DocumentViewState {
  const base = initialViewState(kind);
  if (!isRecord(raw) || raw["kind"] !== kind) return base;
  const query = readQuery(raw["query"]);
  const outline = raw["outline"] === true;
  if (base.kind === "pdf") {
    const scale = raw["scale"];
    return {
      ...base,
      location: readLocation(raw["location"]),
      scale: finite(scale) ? clamp(scale, PDF_ZOOMS[0], PDF_ZOOMS[PDF_ZOOMS.length - 1]!) : "page-width",
      query,
      outline,
    };
  }
  const zoom = raw["zoom"];
  return {
    ...base,
    anchor: readAnchor(raw["anchor"]),
    zoom: finite(zoom) ? clamp(zoom, MARKDOWN_ZOOMS[0], MARKDOWN_ZOOMS[MARKDOWN_ZOOMS.length - 1]!) : 1,
    query,
    outline,
  };
}

/** Whether two states are the same (a host is told only of a change). */
export function sameViewState(a: DocumentViewState, b: DocumentViewState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
