/**
 * The cloze parser and grader (docs/04 §4.6, PLAN-MVP §2.3, decisions D4/D5).
 *
 * This module is the SINGLE source of truth for the `{{…}}` grammar: the editor
 * preview, `toStudent` and the grader all call it, so what the teacher sees,
 * what the student plays and what is graded can never drift.
 *
 * Decision D5: a blank is replaced in the markdown by the sentinel
 * `⸢<index>⸣` (U+2E22 / U+2E23) instead of splitting the text into fragments.
 * The markdown keeps its block structure — lists, tables and fenced code blocks
 * survive — and the renderer only has to swap sentinel text nodes for input
 * components, including inside a code fence.
 *
 * Decision D4: a `select` blank stores the CANONICAL option index as a decimal
 * string, so shuffling never changes a stored answer.
 */
import { seededShuffle, streamSeed } from "@quiz/core/rng";
import {
  ALLOWED_REGEX_FLAGS,
  applyTextOptions,
  isValidPattern,
  matchExact,
  matchNumber,
  matchRegex,
  normalizeInput,
  type ToleranceMode,
} from "./short.js";

export const CLOZE_SENTINEL_OPEN = "⸢";
export const CLOZE_SENTINEL_CLOSE = "⸣";

export function clozeSentinel(index: number): string {
  return `${CLOZE_SENTINEL_OPEN}${index}${CLOZE_SENTINEL_CLOSE}`;
}

/** Matches one sentinel; the capture group is the blank index. Use with the `g` flag when splitting. */
export const CLOZE_SENTINEL_PATTERN = "⸢(\\d+)⸣";

export type ClozeBlank =
  | { index: number; weight: number; kind: "text"; answers: string[] }
  | {
      index: number;
      weight: number;
      kind: "select";
      options: string[];
      correct: number[];
    }
  | { index: number; weight: number; kind: "number"; value: number; tolerance: number; mode: ToleranceMode }
  | { index: number; weight: number; kind: "regex"; pattern: string; flags: string };

export interface ClozeError {
  /** Character offset of the offending `{{` in the source text. */
  at: number;
  /** i18n key, not a sentence. */
  message: string;
}

export interface ClozeParse {
  /** Markdown with each blank replaced by its sentinel. */
  template: string;
  blanks: ClozeBlank[];
  errors: ClozeError[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parses the authoring text. Always total: a malformed blank lands in
 * `errors` and is rendered literally, never thrown, because a teacher must be
 * able to leave a question half-written (decision D16).
 */
export function parseCloze(text: string): ClozeParse {
  // An author typing a raw sentinel would otherwise conjure a phantom input in
  // the player, so the two code points never survive the parse.
  const source = text.split(CLOZE_SENTINEL_OPEN).join("").split(CLOZE_SENTINEL_CLOSE).join("");
  const blanks: ClozeBlank[] = [];
  const errors: ClozeError[] = [];
  let template = "";
  let i = 0;

  while (i < source.length) {
    if (source.startsWith("\\{{", i)) {
      template += "{{";
      i += 3;
      continue;
    }
    if (!source.startsWith("{{", i)) {
      template += source[i];
      i += 1;
      continue;
    }
    const end = findClozeClosingBraces(source, i + 2);
    if (end === -1) {
      errors.push({ at: i, message: "cloze.unterminated" });
      template += "{{";
      i += 2;
      continue;
    }
    const parsed = parseBlankBody(source.slice(i + 2, end), blanks.length);
    if (typeof parsed === "string") {
      errors.push({ at: i, message: parsed });
      template += source.slice(i, end + 2);
    } else {
      blanks.push(parsed);
      template += clozeSentinel(parsed.index);
    }
    i = end + 2;
  }

  return { template, blanks, errors };
}

/**
 * Index of the first unescaped `}}` at or after `from`, or -1.
 *
 * Exported because the rich editor tokenizes the very same hole
 * (`apps/web/src/markdown/tiptap.ts`): the grammar has ONE implementation, and
 * a second one in the editor is exactly how the preview and the grader drift.
 */
export function findClozeClosingBraces(s: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] === "\\") {
      j += 1;
      continue;
    }
    if (s.startsWith("}}", j)) return j;
  }
  return -1;
}

/**
 * Reads ONE hole at the head of `src`, for a markdown tokenizer that walks a
 * string left to right (marked, in the rich editor).
 *
 * `body` is `null` for the escaped opening `\{{`, which the grammar renders as
 * two literal braces; `undefined` comes back when `src` does not start on a
 * hole at all — an unterminated `{{` included, which `parseCloze` reports as
 * `cloze.unterminated` rather than swallowing the rest of the text.
 */
export function matchClozeHole(src: string): { raw: string; body: string | null } | undefined {
  if (src.startsWith("\\{{")) return { raw: "\\{{", body: null };
  if (!src.startsWith("{{")) return undefined;
  const end = findClozeClosingBraces(src, 2);
  if (end === -1) return undefined;
  return { raw: src.slice(0, end + 2), body: src.slice(2, end) };
}

/**
 * Reads ONE blank body — what sits between the braces — into a blank, or
 * returns an i18n key describing why it is invalid.
 *
 * Exported because the blank EDITOR of the rich text field fills its fields
 * from it (`BlankPopover` in `apps/web`): the popup reads a body with the very
 * function the grader reads it with, and writes it back with `formatBlank`
 * below, so a hole the teacher edited can never mean something else than what
 * the card showed.
 */
export function parseBlankBody(body: string, index = 0): ClozeBlank | string {
  let rest = body;
  let weight = 1;
  const weightMatch = /^(\d+(?:\.\d+)?)\*/.exec(rest);
  if (weightMatch !== null) {
    weight = Number(weightMatch[1]);
    rest = rest.slice(weightMatch[0].length);
  }
  if (rest.trim() === "") return "cloze.empty_blank";

  if (rest.startsWith("#")) {
    const m = /^#(-?\d+(?:[.,]\d+)?)(?::(\d+(?:[.,]\d+)?)(%?))?$/.exec(rest.trim());
    if (m === null) return "cloze.invalid_number";
    const value = Number(m[1]!.replace(",", "."));
    const rawTolerance = m[2] === undefined ? 0 : Number(m[2].replace(",", "."));
    const relative = m[3] === "%";
    return {
      index,
      weight,
      kind: "number",
      value,
      tolerance: relative ? rawTolerance / 100 : rawTolerance,
      mode: relative ? "rel" : "abs",
    };
  }

  const regexMatch = /^\/([\s\S]*)\/([A-Za-z]*)$/.exec(rest);
  if (regexMatch !== null) {
    const pattern = regexMatch[1]!;
    const flags = regexMatch[2]!;
    if (!ALLOWED_REGEX_FLAGS.test(flags)) return "cloze.invalid_regex_flags";
    if (!isValidPattern(pattern, flags)) return "cloze.invalid_regex";
    return { index, weight, kind: "regex", pattern, flags };
  }

  const alternatives = splitAlternatives(rest);
  if (alternatives.some((a) => a.startsWith("="))) {
    const options: string[] = [];
    const correct: number[] = [];
    for (const alternative of alternatives) {
      const isCorrect = alternative.startsWith("=");
      const label = unescapeBlank(isCorrect ? alternative.slice(1) : alternative).trim();
      if (label === "") return "cloze.empty_option";
      if (isCorrect) correct.push(options.length);
      options.push(label);
    }
    return { index, weight, kind: "select", options, correct };
  }

  const answers = alternatives.map((a) => unescapeBlank(a).trim()).filter((a) => a !== "");
  if (answers.length === 0) return "cloze.empty_blank";
  return { index, weight, kind: "text", answers };
}

/** Splits on unescaped `|`. */
function splitAlternatives(s: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      current += s[i]! + s[i + 1]!;
      i += 1;
      continue;
    }
    if (s[i] === "|") {
      out.push(current);
      current = "";
      continue;
    }
    current += s[i];
  }
  out.push(current);
  return out;
}

/**
 * A backslash before ASCII PUNCTUATION is that character, inside a blank.
 *
 * The four the grammar table names — `\|`, `\}`, `\*`, `\\` — are the ones a
 * teacher meets. The rule is wider than the table because `formatBlank` below
 * has to be TOTAL: an answer that happens to start with `#`, `/` or `=` would
 * otherwise turn the blank into a number, a regex or a dropdown the teacher
 * never asked for, and the popup would write a body the grader reads
 * differently. Word characters are left alone, so `\d` in a regex — which is
 * not unescaped anyway — and `C:\dir` in an answer keep their backslash.
 */
function unescapeBlank(s: string): string {
  return s.replace(/\\([!-\/:-@[-`{-~])/g, "$1");
}

/** The inverse, for `formatBlank`: what can never travel raw inside a blank. */
function escapeBlank(s: string): string {
  return s.replace(/([\\|}])/g, "\\$1");
}

/**
 * The inverse of `parseBlankBody`: the body a blank would be written as,
 * braces excluded.
 *
 * It is what the blank editor of the rich text field saves, which is why it is
 * here and not in `apps/web`: writing the grammar a second time next to the
 * popup is exactly how what a teacher fills in and what the grader reads would
 * drift. `cloze.test.ts` asserts the round trip on every kind.
 *
 * A regex pattern travels VERBATIM — escaping inside it would change the
 * expression, not protect it — so a pattern holding `}}` cannot be written as
 * a hole. The popup refuses that one by re-parsing what it is about to save.
 */
export function formatBlank(blank: ClozeBlank): string {
  const weight = blank.weight === 1 ? "" : `${blank.weight}*`;
  return weight + blankBody(blank);
}

function blankBody(blank: ClozeBlank): string {
  switch (blank.kind) {
    case "number": {
      if (blank.tolerance === 0) return `#${blank.value}`;
      if (blank.mode === "rel") {
        // The fraction is stored, the percent is written: 0.05 → `5%`, without
        // the 5.000000000000001 a bare multiplication leaves behind.
        return `#${blank.value}:${Number((blank.tolerance * 100).toFixed(6))}%`;
      }
      return `#${blank.value}:${blank.tolerance}`;
    }
    case "regex":
      return `/${blank.pattern}/${blank.flags}`;
    case "text":
      return blank.answers.map((a, i) => guardHead(escapeBlank(a), i === 0)).join("|");
    case "select":
      return blank.options
        .map((label, i) => {
          const escaped = escapeBlank(label);
          // A CORRECT option opens with the `=` the grammar reads as the mark,
          // so a label of its own starting with `=` simply doubles it: `==a`
          // strips one mark and unescapes to `=a`.
          if (blank.correct.includes(i)) return `=${guardHead(escaped, i === 0, true)}`;
          return guardHead(escaped, i === 0);
        })
        .join("|");
  }
}

/**
 * Protects the characters that only mean something at the HEAD of a body: the
 * `=` of a dropdown mark, and — on the first alternative alone, which is where
 * the parser looks — the `#` of a number, the `/` of a regex and the `*` of a
 * leading weight.
 */
function guardHead(s: string, first: boolean, afterMark = false): string {
  let out = s;
  if (out.startsWith("=")) out = `\\${out}`;
  if (!first) return out;
  if (!afterMark) {
    if (out.startsWith("#") || out.startsWith("/")) out = `\\${out}`;
    const weight = /^\d+(?:\.\d+)?\*/.exec(out);
    if (weight !== null) out = `${out.slice(0, weight[0].length - 1)}\\*${out.slice(weight[0].length)}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Student view
// ---------------------------------------------------------------------------

export type ClozeStudentBlank =
  | { index: number; weight: number; kind: "input"; numeric: boolean }
  | { index: number; weight: number; kind: "select"; options: { id: number; label: string }[] };

export interface ClozeStudent {
  template: string;
  blanks: ClozeStudentBlank[];
}

/**
 * The student-facing projection. `text`, `number` and `regex` all collapse to
 * `kind: "input"` — `numeric` only drives `inputmode="decimal"` — so a student
 * cannot tell a regex blank from a plain one and no pattern, tolerance or
 * answer ever leaves the server.
 *
 * `shuffle` must already be the AND of the evaluation switch and the question's
 * `shuffleOptions` flag.
 */
export function clozeStudentTemplate(
  parse: ClozeParse,
  seed: number,
  itemId: string,
  shuffle: boolean,
): ClozeStudent {
  const blanks = parse.blanks.map((blank): ClozeStudentBlank => {
    if (blank.kind !== "select") {
      return { index: blank.index, weight: blank.weight, kind: "input", numeric: blank.kind === "number" };
    }
    const canonical = blank.options.map((label, id) => ({ id, label }));
    const options = shuffle
      ? seededShuffle(canonical, streamSeed(seed, itemId, `options:${blank.index}`))
      : canonical;
    return { index: blank.index, weight: blank.weight, kind: "select", options };
  });
  return { template: parse.template, blanks };
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

export interface ClozeBlankResult {
  index: number;
  weight: number;
  kind: ClozeBlank["kind"];
  ok: boolean;
  given: string | null;
  /**
   * The key for this blank. Teacher-facing: `clozeServer.studentDetails`
   * removes it from the breakdown a student receives unless the feedback
   * policy publishes the key (`showKey`), and the `results` module strips it
   * again on the way out.
   */
  expected: string;
}

export interface ClozeGrade {
  perBlank: ClozeBlankResult[];
  earned: number;
  total: number;
  fraction: number;
}

export function gradeCloze(
  parse: ClozeParse,
  blanks: readonly (string | null)[],
  caseSensitive: boolean,
): ClozeGrade {
  const perBlank = parse.blanks.map((blank): ClozeBlankResult => {
    const given = blanks[blank.index] ?? null;
    return {
      index: blank.index,
      weight: blank.weight,
      kind: blank.kind,
      ok: matchBlank(blank, given, caseSensitive),
      given,
      expected: describeBlank(blank),
    };
  });
  const total = perBlank.reduce((s, b) => s + b.weight, 0);
  const earned = perBlank.reduce((s, b) => (b.ok ? s + b.weight : s), 0);
  return { perBlank, earned, total, fraction: total > 0 ? earned / total : 0 };
}

export function matchBlank(blank: ClozeBlank, given: string | null, caseSensitive: boolean): boolean {
  if (given === null) return false;
  const trimmed = applyTextOptions(normalizeInput(given));
  if (trimmed === "") return false;
  switch (blank.kind) {
    case "text":
      return blank.answers.some((a) => matchExact(given, a, { caseSensitive }));
    case "number":
      return matchNumber(given, { value: blank.value, tolerance: blank.tolerance, toleranceMode: blank.mode });
    case "regex":
      return matchRegex(given, blank.pattern, blank.flags);
    case "select": {
      const id = Number(trimmed);
      return Number.isInteger(id) && blank.correct.includes(id);
    }
  }
}

/** Human rendering of the key, for the teacher panel and the revealed solution. */
export function describeBlank(blank: ClozeBlank): string {
  switch (blank.kind) {
    case "text":
      return blank.answers.join(" | ");
    case "select":
      return blank.correct.map((i) => blank.options[i] ?? "").join(" | ");
    case "number":
      if (blank.tolerance === 0) return String(blank.value);
      return blank.mode === "rel"
        ? `${blank.value} ± ${blank.tolerance * 100} %`
        : `${blank.value} ± ${blank.tolerance}`;
    case "regex":
      return `/${blank.pattern}/${blank.flags}`;
  }
}

/** Sum of the weights; 0 when the text holds no blank. */
export function clozeTotalWeight(parse: ClozeParse): number {
  return parse.blanks.reduce((s, b) => s + b.weight, 0);
}
