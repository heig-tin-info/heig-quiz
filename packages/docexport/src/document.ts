/**
 * The document tree (ADR-121 §1): a short list of block kinds every renderer
 * knows. A block holds text, never markup of the target format, except
 * `markdown`, which passes a statement through as its author wrote it.
 */

/** One test of a program answer, as the staff read it (hidden ones by name). */
export interface TestLine {
  name: string;
  visible: boolean;
  ok: boolean;
  /** What the test is worth, in the question's own case points. */
  points: number;
}

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "markdown"; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; items: readonly string[] }
  | { kind: "table"; header: readonly string[]; rows: readonly (readonly string[])[] }
  | { kind: "tests"; tests: readonly TestLine[] }
  /** `earned: null`: nothing graded yet. */
  | { kind: "points"; earned: number | null; max: number }
  | { kind: "separator" };

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
  blocks: readonly Block[];
}

// --- Builders, so a Source and a type read as the document they write ------

export const heading = (level: 1 | 2 | 3 | 4, text: string): Block => ({ kind: "heading", level, text });
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
