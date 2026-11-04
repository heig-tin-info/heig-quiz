/**
 * The document tree (ADR-121 §1): a short list of block kinds every renderer
 * knows. A block holds text, never markup of the target format, except
 * `markdown`, which passes a statement through as its author wrote it.
 */
import type { Drawing } from "./drawing.js";
import type { Lang, Labels } from "./labels.js";

/** One test of a program answer, as the staff read it (hidden ones by name). */
export interface TestLine {
  name: string;
  visible: boolean;
  ok: boolean;
  /** What the test is worth, in the question's own case points. */
  points: number;
}

export type Block =
  /** `aside`: a short note set apart at the heading's end (a question's points), never part of its text. */
  | { kind: "heading"; level: 1 | 2 | 3 | 4; text: string; aside?: string }
  | { kind: "markdown"; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; items: readonly string[] }
  | { kind: "table"; header: readonly string[]; rows: readonly (readonly string[])[] }
  | { kind: "tests"; tests: readonly TestLine[] }
  /** `earned: null`: nothing graded yet. */
  | { kind: "points"; earned: number | null; max: number }
  | { kind: "separator" }
  | Choices
  | DrawingBlock
  | AnswerZone;

/** One choice of a {@link Choices} block: its letter, and its text as Markdown. */
export interface ChoiceItem {
  label: string;
  text: string;
}

/**
 * The choices of a question, each beside its box: a square when several may
 * be ticked, a round one for one answer, as on the screen. `checked` holds
 * the positions in `items` drawn ticked: none on a statement, the right
 * ones on a key, the ticked ones on an answer — positions, like a stored
 * answer's `selected` (ADR-097).
 *
 * On a hand-out the statement's block IS the paper zone of its item
 * (ADR-125 §6): {@link scopeZones} keys it like an answer zone, and the PDF
 * records it in the manifest as a zone of kind `choices`.
 */
export interface Choices {
  kind: "choices";
  multiple: boolean;
  items: readonly ChoiceItem[];
  checked: readonly number[];
  /** Absent until the document keys it ({@link scopeZones}). */
  id?: string;
}

/**
 * A figure (ADR-126 §1): a closed {@link Drawing}, never markup of the target
 * format. The Typst renderer draws it as an inline SVG, the Markdown renderer
 * as its alt text; a drawing `toSvg` refuses prints its alt text too.
 */
export interface DrawingBlock {
  kind: "drawing";
  drawing: Drawing;
  /** What the figure shows, in words: the Markdown and the refusal print it. */
  alt: string;
  /** The printed width; absent, one pixel per drawing unit (ADR-126 §5). Never wider than the column. */
  widthMm?: number;
  /** The printed height at most: the width narrows to keep it. */
  maxHeightMm?: number;
}

/** What a paper answer space holds (ADR-125); a dropdown blank's options are `bubbles`. */
export type ZoneKind = "bubbles" | "lines" | "free" | "name";

/**
 * Where a student answers on paper (ADR-125): written by a type's
 * `answerZone` hook from the student view only, and by the hand-out for the
 * name fields. `id` is the zone's key in the palier-B manifest, written by
 * the document, never by a type: {@link scopeZones} sets it to the item's id,
 * followed by `:<part>` when the type names the part of its item the zone
 * answers (`b3`, the cloze blank of index 3).
 */
export interface AnswerZone {
  kind: "answerZone";
  /** Absent until the document keys the zone ({@link scopeZones}). */
  id?: string;
  /** The part of its item the zone answers; absent, the whole item. */
  part?: string;
  zone: ZoneKind;
  /** `bubbles`: one label per bubble, in the printed order (a dropdown's options, one to tick). */
  labels?: readonly string[];
  /** `lines`: how many lines to write on; one when absent. */
  lines?: number;
  /** `free`: the height of the frame, in millimetres. */
  heightMm?: number;
  /**
   * `free`: the frame's light-grey pattern (ADR-126 §3), `pitchMm` apart: a
   * square grid to draw on, or ruled lines to write pseudo-code on. The zone
   * stays `free`: graded by hand (ADR-125 §14).
   */
  pattern?: FramePattern;
  /** `free`: a starter drawn in grey at the frame's top left, under the student's drawing (ADR-126 §4). */
  underlay?: Drawing;
}

/** The pattern of a `free` frame (ADR-126 §3). */
export interface FramePattern {
  kind: "grid" | "lines";
  pitchMm: number;
}

/**
 * Where a document comes from (ADR-121 §5): ids only, never a name. The
 * renderer adds the format and the hash of the body.
 */
export interface Provenance {
  /** The record's kind, `item-answers`. */
  kind: string;
  /** The record's version. */
  version: number;
  /** The ids of the source, as the kind has them (`evaluationId`, `itemId`, …). */
  source: Readonly<Record<string, string>>;
  /** The attempts the document holds. */
  attempts: readonly string[];
  /** The server's clock, ISO 8601. */
  generatedAt: string;
  /** The build's commit; null when the process does not know it. */
  app: string | null;
}

export interface Document {
  provenance: Provenance;
  /**
   * The language of the fixed words: the requester's, for a staff document
   * as for a student's (ADR-121 §4 and ADR-125 §7, amended 2026-11-04). The
   * renderers word the document from `LABELS[lang]`, the same words its
   * blocks were built with.
   */
  lang: Lang;
  blocks: readonly Block[];
}

// --- Builders, so a Source and a type read as the document they write ------

export const heading = (level: 1 | 2 | 3 | 4, text: string, aside?: string): Block =>
  aside === undefined ? { kind: "heading", level, text } : { kind: "heading", level, text, aside };
export const markdown = (text: string): Block => ({ kind: "markdown", text });
export const code = (lang: string, text: string): Block => ({ kind: "code", lang, text });
export const list = (items: readonly string[]): Block => ({ kind: "list", items });
export const table = (header: readonly string[], rows: readonly (readonly string[])[]): Block => ({
  kind: "table",
  header,
  rows,
});
export const tests = (lines: readonly TestLine[]): Block => ({ kind: "tests", tests: lines });
export const points = (earned: number | null, max: number): Block => ({ kind: "points", earned, max });
export const separator: Block = { kind: "separator" };
export const drawing = (
  figure: Drawing,
  alt: string,
  size: Pick<DrawingBlock, "widthMm" | "maxHeightMm"> = {},
): DrawingBlock => ({ kind: "drawing", drawing: figure, alt, ...size });

/** Choices beside their boxes, those at `checked` drawn ticked. */
export const choices = (items: readonly ChoiceItem[], multiple: boolean, checked: readonly number[] = []): Choices => ({
  kind: "choices",
  multiple,
  items,
  checked,
});

/** `2`, `1.5`: two decimals at most, as the CSV writes points. */
export const number = (value: number): string => String(Math.round(value * 100) / 100);

/** `2 pt`, `0.5 pt`: a number of points with its unit, never plural. */
export const pointsAside = (labels: Labels, value: number): string => `${number(value)} ${labels.pointsShort}`;

/** `block`, or the sentence that says there is no answer when `isEmpty`. */
export const noAnswerOr = (labels: Labels, isEmpty: boolean, block: Block): Block =>
  isEmpty ? markdown(labels.noAnswer) : block;

/** An answer space (ADR-125). */
export const answerZone = (
  zone: ZoneKind,
  options: Pick<AnswerZone, "part" | "labels" | "lines" | "heightMm" | "pattern" | "underlay"> = {},
): AnswerZone => ({ kind: "answerZone", zone, ...options });

/**
 * One item's blocks with their answer zones keyed to the item: `itemId`, or
 * `itemId:b3` for a zone of part `b3`. A choices block answers its whole
 * item: keyed `itemId`. Other blocks pass as they are.
 */
export const scopeZones = (itemId: string, blocks: readonly Block[]): Block[] =>
  blocks.map((b) => {
    if (b.kind === "answerZone") return { ...b, id: b.part === undefined ? itemId : `${itemId}:${b.part}` };
    if (b.kind === "choices") return { ...b, id: itemId };
    return b;
  });
