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
      /** Set this dropdown came from, when the body was a choice-set key. */
      setKey?: string;
    }
  | { index: number; weight: number; kind: "number"; value: number; tolerance: number; mode: ToleranceMode }
  | { index: number; weight: number; kind: "regex"; pattern: string; flags: string };

/**
 * One PREDEFINED CHOICE SET of a question: a named list of options the teacher
 * writes once and reuses in the text as `{{<key>}}`.
 *
 * It exists because the alternative spelling of a dropdown — `{{=a|b|c}}` —
 * cannot live inside a markdown TABLE CELL, where every unescaped `|` is a
 * column separator, and because the same four options repeated in eight holes
 * were eight places to fix a typo. The set resolves to an ordinary `select`
 * blank at parse time, so `toStudent`, the shuffle (D4), the grader and the
 * player learn nothing new.
 */
export interface ClozeChoiceOption {
  label: string;
  correct: boolean;
}

export interface ClozeChoiceSet {
  /** What a hole names it with: `{{1}}`, `{{unité}}`. */
  key: string;
  options: ClozeChoiceOption[];
}

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
export function parseCloze(text: string, sets: readonly ClozeChoiceSet[] = []): ClozeParse {
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
    const parsed = parseBlankBody(source.slice(i + 2, end), blanks.length, sets);
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

/** Returns the blank, or an i18n key describing why the body is invalid. */
function parseBlankBody(
  body: string,
  index: number,
  sets: readonly ClozeChoiceSet[],
): ClozeBlank | string {
  let rest = body;
  let weight = 1;
  const weightMatch = /^(\d+(?:\.\d+)?)\*/.exec(rest);
  if (weightMatch !== null) {
    weight = Number(weightMatch[1]);
    rest = rest.slice(weightMatch[0].length);
  }
  if (rest.trim() === "") return "cloze.empty_blank";

  /*
   * A PREDEFINED CHOICE SET, before anything else: a body that is EXACTLY the
   * key of a defined set is that set's dropdown. The test is exact — no
   * trimming, no case folding — so `{{0}}` stays the text blank whose answer
   * is "0" as long as no set is called "0", and a question gains a dropdown
   * only when the teacher actually defined one under that name.
   */
  const set = sets.find((candidate) => candidate.key === rest);
  if (set !== undefined) {
    const correct = set.options.flatMap((option, i) => (option.correct ? [i] : []));
    if (correct.length === 0) return "cloze.set_no_correct";
    return {
      index,
      weight,
      kind: "select",
      options: set.options.map((option) => option.label),
      correct,
      setKey: set.key,
    };
  }

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

/** `\|`, `\}`, `\*` and `\\` are literal inside a blank. */
function unescapeBlank(s: string): string {
  return s.replace(/\\([|}*\\])/g, "$1");
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
      /*
       * A set-backed dropdown names its SET and lays the whole list out, the
       * correct ones ticked: the teacher's question says `{{1}}` and nothing
       * else, so a key that only echoed the right label would leave them
       * hunting for which set that was.
       */
      if (blank.setKey !== undefined) {
        const options = blank.options
          .map((label, i) => (blank.correct.includes(i) ? `${label} ✓` : label))
          .join(", ");
        return `set ${blank.setKey} (${options})`;
      }
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
