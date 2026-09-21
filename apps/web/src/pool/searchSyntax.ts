/**
 * The search box of the pool screen, as a small language.
 *
 * A teacher who lives in this screen types faster than they click, and the
 * filter sheet is four lists behind a button. So the field itself accepts the
 * filters as tokens — `tag:pointeurs type:code difficulty:>3 version:>1` — and
 * whatever is left over is the free text the API searches with `q`.
 *
 * The grammar, in one line: `tag:<name>` (or `tag:#<name>`), `type:<id>`,
 * `difficulty:<n|>n|>=n|<n|<=n|a-b>`, `version:<v1|n|>n|>=n|<n|<=n|a-b>`,
 * `"a quoted phrase"`, everything else is free text. A token repeated adds to
 * its set; two version bounds intersect.
 *
 * It is pure on purpose: the parser, the caret probe the completion popover
 * reads and the removal a chip performs are all string in, string out, and
 * `searchSyntax.test.ts` is the specification.
 */
import { QuestionTypeId } from "@quiz/contracts";

/** The four token kinds. The free text is not one: it is what is left. */
export type SearchTokenKind = "tag" | "type" | "difficulty" | "version";

export interface ParsedSearch {
  /** The free text, tokens taken out and quotes stripped. */
  q: string;
  tags: string[];
  types: string[];
  /** `difficulty:>3` arrives here expanded, as the API takes a list. */
  difficulties: number[];
  versionMin: number | null;
  versionMax: number | null;
}

export const EMPTY_PARSE: ParsedSearch = {
  q: "",
  tags: [],
  types: [],
  difficulties: [],
  versionMin: null,
  versionMax: null,
};

/** The ids `type:` accepts, from the contract rather than retyped here. */
export const SEARCH_TYPE_IDS: readonly string[] = QuestionTypeId.options;

const DIFFICULTY_MIN = 1;
const DIFFICULTY_MAX = 5;

/** One whitespace-separated piece of the input, with where it sits. */
interface Piece {
  text: string;
  start: number;
  end: number;
}

/**
 * Splits on whitespace, except inside double quotes: `tag:"deux mots"` and
 * `"une phrase"` are each one piece, quotes included (the value strips them).
 */
function pieces(input: string): Piece[] {
  const out: Piece[] = [];
  let start = -1;
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (ch === '"') {
      if (start < 0) start = i;
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (start >= 0) {
        out.push({ text: input.slice(start, i), start, end: i });
        start = -1;
      }
      continue;
    }
    if (start < 0) start = i;
  }
  if (start >= 0) out.push({ text: input.slice(start, input.length), start, end: input.length });
  return out;
}

/** `"deux mots"` → `deux mots`; an unbalanced quote is simply dropped. */
function unquote(value: string): string {
  return value.replace(/"/g, "");
}

/** `tag:#foo` → `{ kind: "tag", value: "foo" }`; `null` for free text. */
function tokenOf(text: string): { kind: SearchTokenKind; value: string } | null {
  const match = /^(tag|type|difficulty|version):(.*)$/i.exec(text);
  if (!match) return null;
  const kind = match[1]!.toLowerCase() as SearchTokenKind;
  const raw = unquote(match[2]!).trim();
  if (raw === "") return null;
  const value = kind === "tag" ? raw.replace(/^#/, "") : raw;
  return value === "" ? null : { kind, value };
}

/** A bound expression: `3`, `>3`, `>=2`, `<3`, `<=4`, `2-4`. */
function range(value: string, floor: number, ceiling: number): { min: number; max: number } | null {
  const num = (s: string) => {
    const n = Number(s.replace(/^v/i, ""));
    return Number.isInteger(n) ? n : null;
  };
  const cmp = /^(>=|<=|>|<)\s*(v?\d+)$/i.exec(value);
  if (cmp) {
    const n = num(cmp[2]!);
    if (n === null) return null;
    switch (cmp[1]) {
      case ">":
        return { min: n + 1, max: ceiling };
      case ">=":
        return { min: n, max: ceiling };
      case "<":
        return { min: floor, max: n - 1 };
      default:
        return { min: floor, max: n };
    }
  }
  const span = /^(v?\d+)\s*-\s*(v?\d+)$/i.exec(value);
  if (span) {
    const a = num(span[1]!);
    const b = num(span[2]!);
    if (a === null || b === null) return null;
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const one = /^v?\d+$/i.test(value) ? num(value) : null;
  return one === null ? null : { min: one, max: one };
}

/** The difficulties a `difficulty:` token stands for, clamped to 1…5. */
export function difficultyValues(value: string): number[] {
  const bounds = range(value, DIFFICULTY_MIN, DIFFICULTY_MAX);
  if (!bounds) return [];
  const out: number[] = [];
  for (let d = Math.max(bounds.min, DIFFICULTY_MIN); d <= Math.min(bounds.max, DIFFICULTY_MAX); d += 1) {
    out.push(d);
  }
  return out;
}

/** The published-version bounds a `version:` token stands for. */
export function versionBounds(value: string): { min: number | null; max: number | null } | null {
  // A very large ceiling rather than Infinity: the value travels as an integer
  // query parameter, and `versionMax` is only sent when a token set it.
  const bounds = range(value, 0, Number.MAX_SAFE_INTEGER);
  if (!bounds) return null;
  return {
    min: bounds.min <= 0 ? null : bounds.min,
    max: bounds.max >= Number.MAX_SAFE_INTEGER ? null : Math.max(bounds.max, 0),
  };
}

/** The whole field, as data. Unknown `type:` ids and broken bounds are text. */
export function parseSearch(input: string): ParsedSearch {
  const tags: string[] = [];
  const types: string[] = [];
  const difficulties: number[] = [];
  let versionMin: number | null = null;
  let versionMax: number | null = null;
  const free: string[] = [];

  for (const piece of pieces(input)) {
    const token = tokenOf(piece.text);
    if (!token) {
      const text = unquote(piece.text).trim();
      if (text !== "") free.push(text);
      continue;
    }
    if (token.kind === "tag") {
      const tag = token.value.toLowerCase();
      if (!tags.includes(tag)) tags.push(tag);
      continue;
    }
    if (token.kind === "type") {
      const id = token.value.toLowerCase();
      // An id this build does not carry is not a filter; it is what the
      // teacher typed, and the server searches for it like any other word.
      if (!SEARCH_TYPE_IDS.includes(id)) free.push(piece.text);
      else if (!types.includes(id)) types.push(id);
      continue;
    }
    if (token.kind === "difficulty") {
      const values = difficultyValues(token.value);
      if (values.length === 0) free.push(piece.text);
      for (const d of values) if (!difficulties.includes(d)) difficulties.push(d);
      continue;
    }
    const bounds = versionBounds(token.value);
    if (!bounds) {
      free.push(piece.text);
      continue;
    }
    // Two bounds intersect: `version:>1 version:<4` is 2…3.
    if (bounds.min !== null) versionMin = versionMin === null ? bounds.min : Math.max(versionMin, bounds.min);
    if (bounds.max !== null) versionMax = versionMax === null ? bounds.max : Math.min(versionMax, bounds.max);
  }

  return {
    q: free.join(" "),
    tags,
    types,
    difficulties: [...difficulties].sort((a, b) => a - b),
    versionMin,
    versionMax,
  };
}

/**
 * The text without the tokens that carry `value` for `kind` — what removing a
 * chip does. A chip standing for a value a RANGE produced (`difficulty:>3`
 * shows 4 and 5) takes the whole token with it: half a range is not a filter
 * the reader asked for, and leaving `difficulty:>3` behind would put the chip
 * straight back.
 */
export function withoutToken(input: string, kind: SearchTokenKind, value?: string): string {
  const keep = pieces(input).filter((piece) => {
    const token = tokenOf(piece.text);
    if (!token || token.kind !== kind) return true;
    if (value === undefined) return false;
    switch (kind) {
      case "tag":
        return token.value.toLowerCase() !== value.toLowerCase();
      case "type":
        return token.value.toLowerCase() !== value.toLowerCase();
      case "difficulty":
        return !difficultyValues(token.value).includes(Number(value));
      default:
        return false;
    }
  });
  return keep.map((p) => p.text).join(" ");
}

// --- The completion popover ------------------------------------------------

export interface Completion {
  kind: "tag" | "type";
  /** What follows the colon, for the fuzzy filter of the list. */
  prefix: string;
  /** The span of the value in the input, which a pick replaces. */
  start: number;
  end: number;
  /** The token was written `tag:#…`, so the inserted value keeps the `#`. */
  hash: boolean;
}

/**
 * What the caret sits in, or `null`. Only `tag:` and `type:` have a list to
 * offer; `difficulty:` and `version:` are five values and an operator, and a
 * popover for those would be more keystrokes than typing them.
 */
export function completionAt(input: string, caret: number): Completion | null {
  const before = input.slice(0, Math.max(caret, 0));
  const match = /(?:^|\s)(tag|type):(#?)([^\s"]*)$/i.exec(before);
  if (!match) return null;
  const kind = match[1]!.toLowerCase() as "tag" | "type";
  const prefix = match[3]!;
  // The value runs to the end of the word, so a pick made mid-token replaces
  // the whole of it rather than leaving its tail behind.
  const rest = /^[^\s"]*/.exec(input.slice(caret))![0];
  return {
    kind,
    prefix,
    start: before.length - prefix.length,
    end: caret + rest.length,
    hash: match[2] === "#",
  };
}

/** The field after a pick: the value in place, a space after it, caret there. */
export function applyCompletion(
  input: string,
  at: Completion,
  value: string,
): { text: string; caret: number } {
  // `at.start` already sits after the `#` when there is one, so the hash the
  // teacher typed is kept by not touching it.
  const inserted = value;
  const tail = input.slice(at.end);
  const text = `${input.slice(0, at.start)}${inserted}${tail.startsWith(" ") ? "" : " "}${tail}`;
  return { text, caret: at.start + inserted.length + 1 };
}
