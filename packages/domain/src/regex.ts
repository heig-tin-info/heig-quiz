/**
 * The engine of the `regex` matchers of `short` and of the cloze regex blanks
 * (decision D10, ADR-099).
 *
 * A pattern is compiled by RE2 (`re2js`, a pure JavaScript port: no native
 * module), whose matching time is linear in the input. JavaScript's `RegExp`
 * backtracks, and matchers run on the request path — the live verdict of
 * every autosave, practice, the author's try, grading — in the one process
 * that also carries the deadline ticker and the SSE streams: one careless
 * pattern froze the whole API for a minute (security audit, finding H3).
 *
 * Linear in the input is not cheap by itself, so more bounds hold, each
 * checked before the next costs anything:
 *
 *   1. D10: a pattern of at most 300 characters, flags among `imsu`.
 *   2. A static estimate read on the pattern's text before the engine builds
 *      anything (`estimate`): the program's size, the Unicode properties it
 *      builds and copies, the code points a case-insensitive range folds one
 *      by one. It bounds one pattern's build, and a whole question's
 *      (`configPatternProblems`, at publication).
 *   3. The compiled program: at most {@link MAX_PROGRAM_SIZE} instructions,
 *      so one match costs at most that many steps per input character.
 *   4. Its weight in memory (`weightOf`), per pattern and for the whole
 *      cache of compiled patterns.
 *
 * Why the cheap bounds of 1 do not suffice: the length bounds the TEXT, not
 * the program. One counted repetition multiplies (`(.?){999}` is 4 000
 * instructions in ten characters), nested ones multiply again, and capping
 * each count would still let thirty of them follow one another. Nor does the
 * program size bound the BUILD: under `i`, `[Ā-\u{10FFFF}]` is folded code
 * point by code point (125 000 of them, 35 ms) into one instruction, each
 * `\p{Ll}` merges its table with the folding table (0.2 ms), and a repeated
 * property is copied into every state of the one-pass matcher. Hence the
 * estimate, which reads all of it off the text.
 *
 * The refusal is a publication matter (the `publicationIssues` of the two
 * types): a version published under JavaScript's engine stays readable, and
 * a pattern RE2 refuses simply never matches.
 */
import { RE2JS } from "re2js";

/** Decision D10 limits. */
export const MAX_PATTERN_LENGTH = 300;
export const MAX_INPUT_LENGTH = 500;
export const ALLOWED_REGEX_FLAGS = /^[imsu]*$/;
/** The flags of a `regex` matcher that does not say. */
export const DEFAULT_REGEX_FLAGS = "i";

/**
 * The largest RE2 program a pattern may compile to (`programSize`).
 * Ordinary patterns stay far below it — `.{0,100}` is about 200 — and at the
 * bound one match on a 500-character input takes a few milliseconds.
 */
export const MAX_PROGRAM_SIZE = 500;

/**
 * Why a pattern is refused: longer than D10 allows, flags outside `imsu` (or
 * repeated), a syntax error, JavaScript-only syntax RE2 refuses (a
 * backreference, a lookaround, a `\u` escape…), or a program too large to
 * build, run or keep.
 */
export type PatternProblem = "too_long" | "flags" | "syntax" | "unsupported" | "too_complex";

/** The issue key of each problem, the same for a `short` matcher and a cloze blank. */
export const PATTERN_PROBLEM_KEY: Record<PatternProblem, string> = {
  too_long: "regex.invalid",
  syntax: "regex.invalid",
  flags: "regex.invalid_flags",
  unsupported: "regex.unsupported",
  too_complex: "regex.too_complex",
};

/** The issue key of a question whose patterns, each acceptable, together cost too much to build. */
export const CONFIG_TOO_COMPLEX_KEY = "regex.config_too_complex";

/** A matcher's or a blank's pattern, as a config holds it. */
export interface StoredPattern {
  pattern: string;
  flags: string;
}

/** Why a pattern cannot be published, or `null` when it compiles within every bound. */
export function patternProblem(pattern: string, flags = DEFAULT_REGEX_FLAGS): PatternProblem | null {
  const entry = compiled(pattern, flags);
  return typeof entry === "string" ? entry : null;
}

/**
 * The publication check of every pattern of ONE question, in order:
 * `"too_costly"` when their estimated builds together pass
 * {@link CONFIG_BUILD_BUDGET} — read on the text, nothing built, so a draft
 * save cannot cost more than that — else each pattern's own problem.
 */
export function configPatternProblems(patterns: readonly StoredPattern[]): "too_costly" | (PatternProblem | null)[] {
  const cost = patterns.reduce((sum, { pattern, flags }) => sum + buildCost(pattern, flags), 0);
  if (cost > CONFIG_BUILD_BUDGET) return "too_costly";
  return patterns.map(({ pattern, flags }) => patternProblem(pattern, flags));
}

/**
 * Full match of an already normalized candidate (`matchRegex` in `short.ts`
 * normalizes and truncates). A refused pattern never matches.
 */
export function testPattern(candidate: string, pattern: string, flags: string): boolean {
  const entry = compiled(pattern, flags);
  return typeof entry !== "string" && entry.test(candidate);
}

// ---------------------------------------------------------------------------
// The cache, bounded by what it holds
// ---------------------------------------------------------------------------

/**
 * Weights are estimated bytes, calibrated on Node 24 against the heap a full
 * cache retains, the heaviest families of classes included (`\p{^L}`,
 * `\P{Lu}` under `i`, a one-pass `\PL{n}`): a rune of a class about 24 (an
 * array of small integers, with its growth slack and the folded copies the
 * parser keeps), an instruction with its share of the engine's machine
 * about 130, a key and its map slot about 500.
 */
const RUNE_WEIGHT = 24;
const INSTRUCTION_WEIGHT = 130;
const ENTRY_WEIGHT = 512;
/**
 * One pattern: at most 250 kB, so that the 50 blanks of one cloze (12.5 MB)
 * fit four times in the cache and a question's grading never evicts itself.
 */
export const PATTERN_WEIGHT_LIMIT = 250_000;
/** Every compiled pattern together: at most about 48 MB. */
export const CACHE_WEIGHT_LIMIT = 48_000_000;

interface Entry {
  compiled: RE2JS | PatternProblem;
  weight: number;
}

/**
 * Compiled patterns and refusals, by flags and pattern: what V8 did for
 * `RegExp`, and what grading asks for again and again (the cloze grader
 * re-parses on every grade). Least recently used first out, once the weights
 * pass {@link CACHE_WEIGHT_LIMIT}.
 */
const cache = new Map<string, Entry>();
let cacheWeight = 0;

function compiled(pattern: string, flags: string): RE2JS | PatternProblem {
  // The length prefix keeps `flags + pattern` unambiguous whatever either holds.
  const key = `${flags.length}:${flags}${pattern}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.compiled;
  }
  const entry = compile(pattern, flags);
  entry.weight += ENTRY_WEIGHT + 2 * key.length;
  cache.set(key, entry);
  cacheWeight += entry.weight;
  for (const [oldest, old] of cache) {
    if (cacheWeight <= CACHE_WEIGHT_LIMIT) break;
    cache.delete(oldest);
    cacheWeight -= old.weight;
  }
  return entry.compiled;
}

/** An instruction as re2js holds it: here, only the runes of its class. */
interface InstShape {
  runes: readonly number[];
}

/**
 * The re2js internals the weight reads and trims (`re2js` is pinned to one
 * version; `regex.test.ts` fails if this shape changes): the program's
 * instructions, and the one-pass matcher re2js builds beside it when the
 * program allows one, which copies the runes of a class into every
 * instruction that tests it (`\p{L}{1,50}`: fifty copies of `\pL`). Not
 * read: the lazy DFA's state cache (bounded at 8 MB a program by re2js),
 * which stays at 0 states for these anchored sources today — re-check on a
 * re2js bump.
 */
interface ProgramShape {
  re2Input: { prog: { inst: readonly InstShape[] }; onepass: { inst: readonly InstShape[] } | null };
}

/**
 * What instructions hold in memory, in bytes: themselves, and the runes of
 * their classes — each array once, since a repetition shares its class in
 * the program (`\pL{100}` holds one `\pL`).
 */
function weightOf(insts: readonly InstShape[]): number {
  let runes = 0;
  for (const classRunes of new Set(insts.map((inst) => inst.runes))) runes += classRunes.length;
  return insts.length * INSTRUCTION_WEIGHT + runes * RUNE_WEIGHT;
}

/**
 * The weight of a compiled pattern, once its one-pass matcher is dropped
 * when that alone would pass {@link PATTERN_WEIGHT_LIMIT}: the matcher is an
 * optimization, and without it re2js matches by its bounded backtracker or
 * its NFA, linear all the same. `\p{L}{1,50}` stays accepted, at 3 kB.
 */
function trimmedWeight(re: RE2JS): number {
  const shape = (re as unknown as ProgramShape).re2Input;
  const weight = weightOf(shape.prog.inst);
  if (shape.onepass === null) return weight;
  const withOnepass = weight + weightOf(shape.onepass.inst);
  if (withOnepass <= PATTERN_WEIGHT_LIMIT) return withOnepass;
  shape.onepass = null;
  return weight;
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

function compile(pattern: string, flags: string): Entry {
  const refused = (problem: PatternProblem): Entry => ({ compiled: problem, weight: 0 });
  const d10 = d10Problem(pattern, flags);
  if (d10 !== null) return refused(d10);
  if (tooCostly(estimate(pattern, flags))) return refused("too_complex");
  const source = `^(?:${pattern})$`;
  let re: RE2JS;
  try {
    re = RE2JS.compile(`${inlineFlags(flags)}${source}`);
  } catch {
    return refused(compilesInJavaScript(source, flags) ? "unsupported" : "syntax");
  }
  const weight = trimmedWeight(re);
  if (re.programSize() > MAX_PROGRAM_SIZE || weight > PATTERN_WEIGHT_LIMIT) return refused("too_complex");
  return { compiled: re, weight };
}

function d10Problem(pattern: string, flags: string): PatternProblem | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return "too_long";
  if (!ALLOWED_REGEX_FLAGS.test(flags) || new Set(flags).size !== flags.length) return "flags";
  return null;
}

/**
 * The `imsu` flags as RE2's inline flags, which mean what JavaScript's mean.
 * `u` has nothing left to switch on: RE2 always reads the input by code
 * point and always knows `\p{…}`.
 */
function inlineFlags(flags: string): string {
  const kept = flags.replace("u", "");
  return kept === "" ? "" : `(?${kept})`;
}

/**
 * Whether JavaScript would have accepted the pattern: tells "RE2 does not
 * support this" (a backreference, a lookaround) from a plain syntax error.
 * Compiling a `RegExp` never runs it, so this costs no backtracking.
 */
function compilesInJavaScript(source: string, flags: string): boolean {
  try {
    new RegExp(source, flags);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The estimate, read on the text
// ---------------------------------------------------------------------------

/**
 * The estimated size above which the engine is not even asked: twice the
 * bound, a margin for what the estimate misses (RE2 sizes repetitions a
 * little differently).
 */
const ESTIMATE_LIMIT = 2 * MAX_PROGRAM_SIZE;
/** The code points case folding may visit one by one: about half a millisecond. */
const MAX_FOLDED_CODE_POINTS = 2_000;
/** Unicode property escapes written in one pattern: each is built on its own, up to 0.2 ms under `i`. */
const MAX_PROPERTIES = 10;
/** Copies of a property a repetition makes, each copied whole into the one-pass matcher. */
const MAX_PROPERTY_COPIES = 100;
/** RE2's folding window: a range outside it, or covering all of it, is not walked. */
const MIN_FOLD = 0x41;
const MAX_FOLD = 0x1e943;

/**
 * Microseconds, measured on Node 24 with re2js 2.8.6: an instruction, a
 * property escape (merged with the folding table under `i`), a copy of one
 * into the one-pass matcher, a folded code point. The worst pattern the
 * caps above admit costs about 5 ms to build.
 */
const COST_PER_INSTRUCTION = 1;
const COST_PER_PROPERTY = { folded: 200, plain: 40 };
const COST_PER_PROPERTY_COPY = 20;
const COST_PER_FOLDED_CODE_POINT = 0.25;
/**
 * What building every pattern of one question may cost, estimated: 25 ms,
 * ten of the costliest patterns or fifty ordinary ones many times over.
 */
export const CONFIG_BUILD_BUDGET = 25_000;

interface Estimate {
  size: number;
  folded: number;
  properties: number;
  propertyCopies: number;
  folds: boolean;
}

function tooCostly(e: Estimate): boolean {
  return (
    e.size > ESTIMATE_LIMIT ||
    e.folded > MAX_FOLDED_CODE_POINTS ||
    e.properties > MAX_PROPERTIES ||
    e.propertyCopies > MAX_PROPERTY_COPIES
  );
}

/** The estimated build time of one pattern, in microseconds; 0 for one D10 refuses without building. */
function buildCost(pattern: string, flags: string): number {
  if (d10Problem(pattern, flags) !== null) return 0;
  const e = estimate(pattern, flags);
  return (
    e.size * COST_PER_INSTRUCTION +
    e.properties * (e.folds ? COST_PER_PROPERTY.folded : COST_PER_PROPERTY.plain) +
    e.propertyCopies * COST_PER_PROPERTY_COPY +
    e.folded * COST_PER_FOLDED_CODE_POINT
  );
}

/**
 * One open group: its size so far and its property copies, the same of its
 * last atom (what a repetition repeats), its kind.
 */
interface Frame {
  size: number;
  last: number;
  copies: number;
  lastCopies: number;
  capture: boolean;
}

const frame = (capture: boolean): Frame => ({ size: 0, last: 0, copies: 0, lastCopies: 0, capture });

/**
 * The program's size, approximately as RE2 counts it (one instruction per
 * atom and per operator, two per capture, a repetition multiplying what it
 * repeats); the Unicode property escapes written, and the copies the
 * repetitions make of them; the code points folding would walk, when the `i`
 * flag or an inline `(?i…)` applies. Approximate on purpose: a pattern it
 * misreads is a pattern the engine then refuses or measures exactly.
 */
function estimate(pattern: string, flags: string): Estimate {
  const chars = Array.from(pattern);
  const folds = flags.includes("i") || /\(\?[a-zA-Z]*i/.test(pattern);
  const frames: Frame[] = [frame(false)];
  const top = () => frames[frames.length - 1]!;
  const atom = (size: number, copies: number) => {
    top().size += size;
    top().last = size;
    top().copies += copies;
    top().lastCopies = copies;
  };
  let folded = 0;
  let properties = 0;
  let i = 0;
  while (i < chars.length) {
    const c = chars[i]!;
    if (c === "\\" && chars[i + 1] === "Q") {
      const end = findSequence(chars, ["\\", "E"], i + 2);
      for (let j = i + 2; j < end; j++) atom(1, 0);
      i = end + 2;
    } else if (c === "\\") {
      const property = isProperty(chars, i) ? 1 : 0;
      properties += property;
      i = escapeEnd(chars, i);
      atom(1, property);
    } else if (c === "[") {
      const cls = scanClass(chars, i);
      if (folds) folded += cls.folded;
      properties += cls.properties;
      i = cls.end;
      atom(1, cls.properties);
    } else if (c === "(") {
      i = openGroup(chars, i, frames);
    } else if (c === ")" && frames.length > 1) {
      const group = frames.pop()!;
      atom(group.size + (group.capture ? 2 : 0), group.copies);
      i += 1;
    } else if (c === "|" || c === "*" || c === "+" || c === "?") {
      top().size += 1;
      if (c === "|") {
        top().last = 0;
        top().lastCopies = 0;
      }
      i += 1;
    } else {
      const repeat = c === "{" ? /^\{(\d+)(?:(,)(\d*))?\}/.exec(chars.slice(i, i + 24).join("")) : null;
      if (repeat === null) {
        atom(1, 0);
        i += 1;
      } else {
        const min = Number(repeat[1]);
        const max = repeat[2] === undefined ? min : repeat[3] === "" ? min + 1 : Number(repeat[3]);
        const times = Math.max(1, min, max);
        const t = top();
        t.size += t.last * (times - 1);
        t.last *= times;
        t.copies += t.lastCopies * (times - 1);
        t.lastCopies *= times;
        i += repeat[0].length;
      }
    }
  }
  const size = frames.reduce((sum, f) => sum + f.size + (f.capture ? 2 : 0), 0);
  const propertyCopies = frames.reduce((sum, f) => sum + f.copies, 0);
  return { size, folded, properties, propertyCopies, folds };
}

/** `(`: a capture, a `(?:…)` or `(?flags:…)` group, or a bare `(?flags)` that opens nothing. */
function openGroup(chars: readonly string[], i: number, frames: Frame[]): number {
  if (chars[i + 1] !== "?") {
    frames.push(frame(true));
    return i + 1;
  }
  let j = i + 2;
  while (j < chars.length && /[a-zA-Z-]/.test(chars[j]!)) j++;
  if (chars[j] === ")") return j + 1;
  if (chars[j] === ":") {
    frames.push(frame(false));
    return j + 1;
  }
  // A named group (`(?P<name>`, `(?<name>`) or a lookaround RE2 will refuse:
  // the rest of the prefix is read as atoms, an overestimate of a few.
  frames.push(frame(true));
  return i + 2;
}

/** `\p…` or `\P…`: a Unicode property, `\pL`, `\p{Greek}`, `\P{^Lu}`. */
function isProperty(chars: readonly string[], i: number): boolean {
  return chars[i + 1] === "p" || chars[i + 1] === "P";
}

/**
 * A bracket class: where it ends, the code points its ranges make folding
 * walk, and the Unicode properties written in it.
 */
function scanClass(chars: readonly string[], start: number): { end: number; folded: number; properties: number } {
  let i = start + 1;
  if (chars[i] === "^") i++;
  let folded = 0;
  let properties = 0;
  let first = true;
  while (i < chars.length && (chars[i] !== "]" || first)) {
    first = false;
    if (chars[i] === "[" && chars[i + 1] === ":") {
      const close = findSequence(chars, [":", "]"], i + 2);
      if (close < chars.length) {
        i = close + 2;
        continue;
      }
    }
    if (chars[i] === "\\" && /[pPdDsSwW]/.test(chars[i + 1] ?? "")) {
      if (isProperty(chars, i)) properties += 1;
      i = escapeEnd(chars, i);
      continue;
    }
    const lo = classChar(chars, i);
    let hi = lo.value;
    i = lo.end;
    if (chars[i] === "-" && i + 1 < chars.length && chars[i + 1] !== "]") {
      const upper = classChar(chars, i + 1);
      hi = upper.value;
      i = upper.end;
    }
    folded += foldedSpan(lo.value, hi);
  }
  return { end: i + 1, folded, properties };
}

const CONTROL_ESCAPES: Record<string, number> = { a: 7, f: 12, n: 10, r: 13, t: 9, v: 11 };

/** One endpoint of a class range: a character, or an escape that stands for one. */
function classChar(chars: readonly string[], i: number): { value: number; end: number } {
  const c = chars[i] ?? "";
  if (c !== "\\") return { value: c.codePointAt(0) ?? 0, end: i + 1 };
  const e = chars[i + 1] ?? "";
  const end = escapeEnd(chars, i);
  const body = chars.slice(i + 2, end).join("");
  let value: number;
  if (e === "x") value = parseInt(body.replace(/[{}]/g, ""), 16);
  else if (/[0-7]/.test(e)) value = parseInt(chars.slice(i + 1, end).join(""), 8);
  else value = CONTROL_ESCAPES[e] ?? e.codePointAt(0) ?? 0;
  return { value: Number.isFinite(value) ? value : 0, end };
}

/** Where the escape starting at `i` ends: `\x{…}` and `\p{…}` to their brace, `\xHH`, `\pL`, octal digits. */
function escapeEnd(chars: readonly string[], i: number): number {
  const e = chars[i + 1] ?? "";
  if ((e === "x" || e === "p" || e === "P") && chars[i + 2] === "{") {
    return Math.min(chars.length, findSequence(chars, ["}"], i + 3) + 1);
  }
  if (e === "x") return i + 4;
  if (e === "p" || e === "P") return i + 3;
  if (/[0-7]/.test(e)) {
    let j = i + 2;
    while (j < i + 4 && /[0-7]/.test(chars[j] ?? "")) j++;
    return j;
  }
  return i + 2;
}

/** The index of `sequence` from `from`, or the end of `chars`. */
function findSequence(chars: readonly string[], sequence: readonly string[], from: number): number {
  for (let j = from; j + sequence.length <= chars.length; j++) {
    if (sequence.every((s, k) => chars[j + k] === s)) return j;
  }
  return chars.length;
}

/** The code points RE2 folds one by one for the range `lo-hi` (`appendFoldedRange`). */
function foldedSpan(lo: number, hi: number): number {
  if (hi < lo || (lo <= MIN_FOLD && hi >= MAX_FOLD)) return 0;
  return Math.max(0, Math.min(hi, MAX_FOLD) - Math.max(lo, MIN_FOLD) + 1);
}
