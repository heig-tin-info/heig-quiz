/**
 * How a test's expected and obtained outputs are SHOWN side by side or as a
 * diff (issue #553). The verdict stays `compareOutput`'s; these functions only
 * explain it, and they follow the same options so that a difference the grade
 * ignores (trailing whitespace, case) is never drawn as an error. A numeric
 * tolerance (`numeric`) is not: within a numeric case the diff only stops
 * flagging whitespace between tokens, and two numbers within the epsilon of
 * each other still read as different characters.
 *
 * Pure, no dependency: an in-house LCS rather than a diff library. Outputs
 * reach the runner's output cap (`RUNNER_MAX_OUTPUT_KB`, 256 KB by default),
 * so one budget of LCS cells bounds the work of a whole diff; past it, a
 * block is drawn as changed whole lines.
 */
import { compareOutput, lineBody, normalizeLine, type CompareOptions } from "./compareOutput.js";

/** The whitespace a reader cannot see and a comparison can trip on. */
export type WhitespaceKind = "space" | "tab" | "cr" | "nbsp" | "zw";

/** A run of text: plain (`ws: null`) or one kind of whitespace to make visible. */
export interface TextSpan {
  text: string;
  ws: WhitespaceKind | null;
}

const NBSP = /[\u00a0\u2007\u202f]/;
/** The zero-width characters, once: the glyph rule and the squeeze both read it. */
const ZERO_WIDTH_CHARS = "\u200b\u200c\u200d\u2060\ufeff";
const ZERO_WIDTH = new RegExp(`[${ZERO_WIDTH_CHARS}]`);
const INVISIBLE_RUN = new RegExp(`[\\s${ZERO_WIDTH_CHARS}]+`, "g");

/** The kind of an invisible character, `null` for any other. */
export function whitespaceKind(ch: string): WhitespaceKind | null {
  if (ch === " ") return "space";
  if (ch === "\t") return "tab";
  if (ch === "\r") return "cr";
  if (NBSP.test(ch)) return "nbsp";
  if (ZERO_WIDTH.test(ch)) return "zw";
  return null;
}

/**
 * Splits a text into plain runs and runs of whitespace worth showing.
 *
 * Not every space: a single space between two words is how text looks, and a
 * glyph on each of them drowns the output. What is marked is what people get
 * wrong — leading and trailing spaces, a doubled space, every tab, a carriage
 * return, a non-breaking or zero-width character. Concatenating the spans
 * gives the text back, character for character.
 */
export function whitespaceSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  const push = (chunk: string, ws: WhitespaceKind | null) => {
    const last = spans[spans.length - 1];
    if (last !== undefined && last.ws === ws) last.text += chunk;
    else spans.push({ text: chunk, ws });
  };
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    const kind = whitespaceKind(ch);
    if (kind !== "space") {
      push(ch, kind);
      continue;
    }
    // A run of spaces: marked when doubled, when it opens its line, or when
    // only whitespace follows it up to the end of the line.
    let end = i;
    while (chars[end] === " ") end += 1;
    let j = end;
    while (chars[j] === "\t" || chars[j] === " ") j += 1;
    const leading = i === 0 || chars[i - 1] === "\n";
    const trailing = j === chars.length || chars[j] === "\n" || chars[j] === "\r";
    const run = chars.slice(i, end).join("");
    push(run, end - i > 1 || leading || trailing ? "space" : null);
    i = end - 1;
  }
  return spans;
}

/**
 * Whether a "no newline at the end" marker is worth showing: only when the
 * comparison would notice it. With `trimTrailing` (the default) trailing
 * newlines never decide a grade, so the marker would point at nothing.
 */
export function missingFinalNewline(text: string, opts: CompareOptions = {}): boolean {
  return opts.trimTrailing === false && text !== "" && !text.endsWith("\n");
}

function squeeze(s: string, opts: CompareOptions): string {
  const out = s.replace(INVISIBLE_RUN, "");
  return opts.ignoreCase === true ? out.toLowerCase() : out;
}

/**
 * True when the comparison refuses two outputs that are nevertheless the same
 * text once every whitespace character is erased: the case where a reader
 * stares at two identical columns. A difference the options ignore (trailing
 * spaces under `trimTrailing`) does not count.
 */
export function differsOnlyByWhitespace(
  expected: string,
  actual: string,
  opts: CompareOptions = {},
): boolean {
  return squeeze(expected, opts) === squeeze(actual, opts) && !compareOutput(expected, actual, opts);
}

/** A piece of a diff line; `changed` marks the characters that differ. */
export interface DiffSegment {
  text: string;
  changed: boolean;
}

/** One line of a unified diff: in both outputs, only expected, or only obtained. */
export interface DiffLine {
  op: "equal" | "removed" | "added";
  segments: DiffSegment[];
  /**
   * The last line of its output, with no newline after it — set only when
   * the comparison counts trailing newlines (`trimTrailing: false`).
   */
  noNewline?: true;
}

export interface DiffOptions extends CompareOptions {
  /**
   * The obtained output was cut by the runner. The expected one is then
   * compared up to the same length, so the cut is not drawn as missing lines.
   */
  truncated?: boolean | undefined;
}

/**
 * The LCS cells one whole diff may fill, the line diff and every character
 * diff together. Past it, a block is replaced whole.
 */
export const DIFF_CELL_BUDGET = 2_000_000;

/** What remains of the budget, spent by each LCS table as it is built. */
interface Budget {
  cells: number;
}

type Op = { op: "equal" | "removed" | "added"; a: number; b: number };

/**
 * The edit script between two sequences, compared by key: an LCS over the
 * middle once the common prefix and suffix are set aside. When the middle's
 * table does not fit in what remains of the budget, it is reported as removed
 * then added — honest, if coarse.
 */
function editScript(a: readonly string[], b: readonly string[], budget: Budget): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ op: "equal", a: i, b: i });

  const n = endA - start;
  const m = endB - start;
  if (n * m > budget.cells) {
    for (let i = start; i < endA; i += 1) ops.push({ op: "removed", a: i, b: -1 });
    for (let j = start; j < endB; j += 1) ops.push({ op: "added", a: -1, b: j });
  } else {
    budget.cells -= n * m;
    // lcs[i][j] = length of the LCS of a[start+i..endA) and b[start+j..endB).
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * width + j] =
          a[start + i] === b[start + j]
            ? lcs[(i + 1) * width + j + 1]! + 1
            : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        ops.push({ op: "equal", a: start + i, b: start + j });
        i += 1;
        j += 1;
      } else if (j < m && (i === n || lcs[i * width + j + 1]! >= lcs[(i + 1) * width + j]!)) {
        ops.push({ op: "added", a: -1, b: start + j });
        j += 1;
      } else {
        ops.push({ op: "removed", a: start + i, b: -1 });
        i += 1;
      }
    }
  }
  for (let k = 0; endA + k < a.length; k += 1) ops.push({ op: "equal", a: endA + k, b: endB + k });
  return ops;
}

/** A line as the comparison reads it; a numeric case compares tokens, so blanks between them never count. */
function lineKey(line: string, opts: CompareOptions): string {
  const key = normalizeLine(line, opts);
  return opts.numeric != null ? key.trim().split(/\s+/).join(" ") : key;
}

/**
 * The lines of an output, and whether the last one lacks its newline — which
 * only counts when trailing newlines do (`trimTrailing: false`).
 */
interface Lines {
  lines: string[];
  open: boolean;
}

function splitLines(text: string, opts: CompareOptions): Lines {
  const lines = text.split("\n");
  // The final newline ends the last line, it does not open one.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  if (opts.trimTrailing !== false) {
    while (lines.length > 0 && lineKey(lines[lines.length - 1]!, opts) === "") lines.pop();
  }
  return { lines, open: missingFinalNewline(text, opts) };
}

function keysOf({ lines, open }: Lines, opts: CompareOptions): string[] {
  const keys = lines.map((l) => lineKey(l, opts));
  // A line without its newline is not the same line as one with it.
  if (open) keys[keys.length - 1] += "\u0000";
  return keys;
}

function merge(segments: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last !== undefined && last.changed === s.changed) last.text += s.text;
    else if (s.text !== "") out.push({ ...s });
  }
  return out;
}

/** The part of a line the comparison reads, and the tail it ignores. */
function splitTail(line: string, opts: CompareOptions): [string, string] {
  const cut = lineBody(line, opts).length;
  return [line.slice(0, cut), line.slice(cut)];
}

/**
 * The character diff of a changed pair of lines: the removed side, then the
 * added one. Once the budget is spent, the pair comes back changed whole.
 */
function charDiff(
  removed: string,
  added: string,
  opts: CompareOptions,
  budget: Budget,
): [DiffSegment[], DiffSegment[]] {
  const [bodyA, tailA] = splitTail(removed, opts);
  const [bodyB, tailB] = splitTail(added, opts);
  const a = Array.from(bodyA);
  const b = Array.from(bodyB);
  if (a.length * b.length > budget.cells) {
    return [
      merge([{ text: bodyA, changed: true }, { text: tailA, changed: false }]),
      merge([{ text: bodyB, changed: true }, { text: tailB, changed: false }]),
    ];
  }
  const key = (c: string) => (opts.ignoreCase === true ? c.toLowerCase() : c);
  const ops = editScript(a.map(key), b.map(key), budget);
  const left: DiffSegment[] = [];
  const right: DiffSegment[] = [];
  for (const op of ops) {
    if (op.op !== "added") left.push({ text: a[op.a]!, changed: op.op === "removed" });
    if (op.op !== "removed") right.push({ text: b[op.b]!, changed: op.op === "added" });
  }
  // The ignored tail (trailing whitespace under `trimTrailing`) is shown, never flagged.
  left.push({ text: tailA, changed: false });
  right.push({ text: tailB, changed: false });
  return [merge(left), merge(right)];
}

/**
 * The unified diff of an expected and an obtained output: lines compared as
 * `compareOutput` compares them, then, for each changed pair of lines, the
 * characters — what makes a one-space difference readable.
 *
 * A block of changed lines lists the expected lines first (`removed`), then
 * the obtained ones (`added`); its lines are paired in order for the
 * character diff, and an unpaired line is changed as a whole.
 */
export function diffOutput(expected: string, actual: string, opts: DiffOptions = {}): DiffLine[] {
  const want = opts.truncated === true ? expected.slice(0, actual.length) : expected;
  const left = splitLines(want, opts);
  const right = splitLines(actual, opts);
  // A truncated output ends at the runner's cut, not on a missing newline.
  if (opts.truncated === true) left.open = right.open = false;
  const a = left.lines;
  const b = right.lines;
  const budget: Budget = { cells: DIFF_CELL_BUDGET };
  const ops = editScript(keysOf(left, opts), keysOf(right, opts), budget);
  const openA = left.open ? a.length - 1 : -1;
  const openB = right.open ? b.length - 1 : -1;
  const line = (op: DiffLine["op"], segments: DiffSegment[], open: boolean): DiffLine =>
    open ? { op, segments, noNewline: true } : { op, segments };
  const out: DiffLine[] = [];
  let k = 0;
  while (k < ops.length) {
    const op = ops[k]!;
    if (op.op === "equal") {
      out.push(line("equal", [{ text: b[op.b]!, changed: false }], op.b === openB));
      k += 1;
      continue;
    }
    const removed: number[] = [];
    const added: number[] = [];
    while (k < ops.length && ops[k]!.op !== "equal") {
      const o = ops[k]!;
      if (o.op === "removed") removed.push(o.a);
      else added.push(o.b);
      k += 1;
    }
    const before: DiffLine[] = [];
    const after: DiffLine[] = [];
    removed.forEach((ia, i) => {
      const ib = added[i];
      if (ib === undefined) {
        before.push(line("removed", [{ text: a[ia]!, changed: true }], ia === openA));
        return;
      }
      const [l, r] = charDiff(a[ia]!, b[ib]!, opts, budget);
      before.push(line("removed", l, ia === openA));
      after.push(line("added", r, ib === openB));
    });
    for (const ib of added.slice(removed.length)) {
      after.push(line("added", [{ text: b[ib]!, changed: true }], ib === openB));
    }
    out.push(...before, ...after);
  }
  return out;
}
