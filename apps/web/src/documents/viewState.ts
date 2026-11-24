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
 * is read through {@link readViewState}, which never trusts its shape: one
 * schema gives the type and the reader, each field falling back to its
 * default and every number clamped.
 */
import { z } from "zod";

export type DocumentKind = "pdf" | "markdown";

/** The scales a PDF steps through; fit-width may land between two of them. */
export const PDF_ZOOMS = [0.5, 0.67, 0.75, 0.85, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
/** The text sizes of a Markdown document. */
export const MARKDOWN_ZOOMS = [0.85, 1, 1.15, 1.3, 1.5, 1.75] as const;

/** A search query longer than this is cut: nobody types it, and a stored one is not trusted. */
export const MAX_QUERY = 200;

const EPSILON = 0.001;

const clamp = (min: number, max: number) => (value: number) => Math.min(Math.max(value, min), max);
const lowest = (ladder: readonly number[]) => ladder[0]!;
const highest = (ladder: readonly number[]) => ladder[ladder.length - 1]!;

const Query = z.string().transform((query) => query.slice(0, MAX_QUERY)).catch("");
const Outline = z.boolean().catch(false);
/** A coordinate of a PDF point: a finite number (zod refuses NaN and the infinities), else none. */
const Coordinate = z.number().nullable().catch(null);

/** A point of a PDF page, in PDF units (pdf.js's `XYZ` destination). */
const PdfLocation = z.object({
  pageNumber: z.number().min(1).transform(Math.floor),
  top: Coordinate,
  left: Coordinate,
});
export type PdfLocation = z.infer<typeof PdfLocation>;

/** The first Markdown block not yet scrolled past, and how far into it the top of the view is (negative above the first). */
const MarkdownAnchor = z.object({
  block: z.number().min(0).transform(Math.floor),
  fraction: z.number().transform(clamp(-1, 1)),
});
export type MarkdownAnchor = z.infer<typeof MarkdownAnchor>;

const PdfViewState = z.object({
  kind: z.literal("pdf"),
  location: PdfLocation.nullable().catch(null),
  /** `page-width` follows the viewer's width; a number is a fixed scale. */
  scale: z
    .union([z.literal("page-width"), z.number().transform(clamp(lowest(PDF_ZOOMS), highest(PDF_ZOOMS)))])
    .catch("page-width"),
  query: Query,
  outline: Outline,
});

const MarkdownViewState = z.object({
  kind: z.literal("markdown"),
  anchor: MarkdownAnchor.nullable().catch(null),
  /** The text size, 1 being the journal's. */
  zoom: z.number().transform(clamp(lowest(MARKDOWN_ZOOMS), highest(MARKDOWN_ZOOMS))).catch(1),
  query: Query,
  outline: Outline,
});

/** The reading state of a viewer, as a host keeps it. */
export const DocumentViewState = z.discriminatedUnion("kind", [PdfViewState, MarkdownViewState]);
export type DocumentViewState = z.infer<typeof DocumentViewState>;
export type PdfViewState = z.infer<typeof PdfViewState>;
export type MarkdownViewState = z.infer<typeof MarkdownViewState>;
export type PdfScale = PdfViewState["scale"];

/** One step along `ladder` from `current` (which may sit between two rungs), towards `dir`. */
export function zoomStep(ladder: readonly number[], current: number, dir: 1 | -1): number {
  if (dir > 0) return ladder.find((rung) => rung > current + EPSILON) ?? highest(ladder);
  return [...ladder].reverse().find((rung) => rung < current - EPSILON) ?? lowest(ladder);
}

/** Whether a step towards `dir` changes anything. */
export function canZoom(ladder: readonly number[], current: number, dir: 1 | -1): boolean {
  return dir > 0 ? current < highest(ladder) - EPSILON : current > lowest(ladder) + EPSILON;
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

/** The state a viewer starts from when nothing was kept. */
export function initialViewState(kind: DocumentKind): DocumentViewState {
  return DocumentViewState.parse({ kind });
}

/**
 * A kept state, read back for a document of `kind`: every field checked and
 * clamped, anything missing or malformed replaced by its default. A state of
 * the other kind, or no state at all, is the initial one.
 */
export function readViewState(kind: DocumentKind, raw: unknown): DocumentViewState {
  const read = DocumentViewState.safeParse(raw);
  return read.success && read.data.kind === kind ? read.data : initialViewState(kind);
}

/** Whether two states are the same (a host is told only of a change). */
export function sameViewState(a: DocumentViewState, b: DocumentViewState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
