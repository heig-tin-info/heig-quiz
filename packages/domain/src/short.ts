/**
 * Normalisation and matchers for the `short` question type (docs/04 §4.5,
 * PLAN-MVP §2.2 and §7). Reused by the cloze grader for `text`, `number` and
 * `regex` blanks, so that the two types never drift apart.
 *
 * Decision D9: a case-insensitive comparison folds with `toLocaleLowerCase("fr")`
 * and ACCENTS STAY SIGNIFICANT — "Galilee" does not match "Galilée". A teacher
 * who disagrees adds an alternative or a regex.
 *
 * Decision D10 (ReDoS): a pattern is at most 300 characters, the input at most
 * 500, and the flags are restricted to `imsu`. Bounding the input was not
 * enough: a backtracking engine is exponential in it, and matchers DO run on
 * the request path — the live verdict of every autosave, practice, the
 * author's "try", the grading job — in the one process that also carries the
 * deadline ticker and the SSE streams. One careless pattern froze the whole
 * API for a minute (security audit, finding H3). A pattern is therefore
 * compiled by RE2 (`re2js`, a pure JavaScript port that runs in the browser
 * as well as in Node), whose matching time is linear in the input: no
 * backreference, no lookaround, refused at publication like a syntax error.
 * Linear is not cheap when the program is huge (`(.?){999}` repeated), so the
 * compiled program is bounded too: one match costs at most
 * `MAX_PROGRAM_SIZE × MAX_INPUT_LENGTH` steps.
 */
import { RE2JS } from "re2js";

/** Decision D10 limits. */
export const MAX_PATTERN_LENGTH = 300;
export const MAX_INPUT_LENGTH = 500;
export const ALLOWED_REGEX_FLAGS = /^[imsu]*$/;
/**
 * The largest RE2 program a pattern may compile to (RE2's `programSize`).
 * Ordinary patterns stay far below it — `.{0,100}` is about 200 — and at the
 * limit one match on a 500-character input takes a few milliseconds.
 */
export const MAX_PROGRAM_SIZE = 500;

export type ToleranceMode = "abs" | "rel";

export type ShortMatcher =
  | {
      kind: "exact";
      value: string;
      caseSensitive?: boolean | undefined;
      trim?: boolean | undefined;
      collapseSpaces?: boolean | undefined;
      points?: number | undefined;
    }
  | { kind: "regex"; pattern: string; flags?: string | undefined; points?: number | undefined }
  | {
      kind: "number";
      /**
       * A string is a `[[…]]` reference of a parameterized TEMPLATE (ADR-056
       * §4): it is described as written and never matches. An instance holds
       * numbers.
       */
      value: number | string;
      tolerance?: number | string | undefined;
      toleranceMode?: ToleranceMode | undefined;
      unit?: string | undefined;
      unitRequired?: boolean | undefined;
      points?: number | undefined;
    }
  | { kind: "date"; value: string; toleranceDays?: number | undefined; points?: number | undefined }
  | { kind: "time"; value: string; toleranceMinutes?: number | undefined; points?: number | undefined }
  | { kind: "llm"; rubric: string; reference?: string | undefined; points?: number | undefined };

/**
 * Why a pattern is refused: longer than D10 allows, flags outside `imsu` (or
 * repeated), a syntax error, a construct JavaScript knows but RE2 refuses
 * (a backreference, a lookaround, `\u00e9`…), or a program above
 * {@link MAX_PROGRAM_SIZE}.
 */
export type PatternProblem = "too_long" | "flags" | "syntax" | "unsupported" | "too_complex";

/** A pattern that cannot be compiled, or that breaks a D10 limit. */
export class InvalidMatcherPattern extends Error {
  readonly code = "invalid_matcher_pattern";

  constructor(
    readonly pattern: string,
    readonly problem: PatternProblem,
    readonly reason: string,
  ) {
    super(`invalid matcher pattern: ${reason}`);
    this.name = "InvalidMatcherPattern";
  }
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Step 1 of the pipeline: NFC, CRLF -> LF, every exotic space -> U+0020. */
export function normalizeInput(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[      ]/g, " ");
}

export interface TextOptions {
  trim?: boolean | undefined;
  collapseSpaces?: boolean | undefined;
}

/** Steps 2 of the pipeline: optional trim, optional whitespace collapse. */
export function applyTextOptions(s: string, opts: TextOptions = {}): string {
  let out = s;
  if (opts.collapseSpaces !== false) out = out.replace(/\s+/g, " ");
  if (opts.trim !== false) out = out.trim();
  return out;
}

/** Decision D9: fold case in French, keep the accents. */
export function foldCase(s: string): string {
  return s.toLocaleLowerCase("fr");
}

// ---------------------------------------------------------------------------
// exact
// ---------------------------------------------------------------------------

export function matchExact(
  input: string,
  value: string,
  opts: TextOptions & { caseSensitive?: boolean | undefined } = {},
): boolean {
  const a = applyTextOptions(normalizeInput(input), opts);
  const b = applyTextOptions(normalizeInput(value), opts);
  return opts.caseSensitive === true ? a === b : foldCase(a) === foldCase(b);
}

// ---------------------------------------------------------------------------
// regex
// ---------------------------------------------------------------------------

/** What a compiled pattern offers: a boolean test, never a capture. */
export interface FullMatcher {
  test(input: string): boolean;
}

/**
 * The `imsu` flags as RE2's inline flags, which mean what JavaScript's mean.
 * `u` has nothing left to switch on: RE2 always reads the input by code
 * point and always knows `\p{…}`. A function, not a table of `RE2JS`
 * constants: a module-level read of the engine would keep it in every
 * browser bundle that imports this file for anything else.
 */
function inlineFlags(flags: string): string {
  const kept = flags.replace("u", "");
  return kept === "" ? "" : `(?${kept})`;
}

/**
 * Compiled patterns, by flags and pattern: what V8 did for `RegExp`, and
 * what an autosave asks for again and again. A refusal is remembered too, so
 * an old pattern RE2 rejects is not recompiled on every keystroke. Bounded,
 * the oldest entry leaving first.
 */
const compiled = new Map<string, FullMatcher | InvalidMatcherPattern>();
const COMPILED_LIMIT = 1000;

/**
 * Compiles a matcher pattern as a FULL match, the way the spec defines it,
 * with RE2 (linear time, see the header). Called at publication time so that
 * an invalid pattern is a publication error, never a grading-time surprise;
 * throws {@link InvalidMatcherPattern}.
 */
export function compileFullMatch(pattern: string, flags = "i"): FullMatcher {
  const entry = compiledEntry(pattern, flags);
  if (entry instanceof InvalidMatcherPattern) throw entry;
  return entry;
}

/** Why a pattern cannot be published, or `null` when it compiles within every limit. */
export function patternProblem(pattern: string, flags = "i"): PatternProblem | null {
  const entry = compiledEntry(pattern, flags);
  return entry instanceof InvalidMatcherPattern ? entry.problem : null;
}

/** Publication-time validation: does this pattern compile within the D10 limits? */
export function isValidPattern(pattern: string, flags = "i"): boolean {
  return patternProblem(pattern, flags) === null;
}

function compiledEntry(pattern: string, flags: string): FullMatcher | InvalidMatcherPattern {
  // The length prefix keeps `flags + pattern` unambiguous whatever either holds.
  const key = `${flags.length}:${flags}${pattern}`;
  let entry = compiled.get(key);
  if (entry === undefined) {
    entry = compileOrRefuse(pattern, flags);
    if (compiled.size >= COMPILED_LIMIT) compiled.delete(compiled.keys().next().value!);
    compiled.set(key, entry);
  }
  return entry;
}

function compileOrRefuse(pattern: string, flags: string): FullMatcher | InvalidMatcherPattern {
  const refuse = (problem: PatternProblem, reason: string) => new InvalidMatcherPattern(pattern, problem, reason);
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return refuse("too_long", `pattern longer than ${MAX_PATTERN_LENGTH} characters`);
  }
  if (!ALLOWED_REGEX_FLAGS.test(flags) || new Set(flags).size !== flags.length) {
    return refuse("flags", `flags must match ${String(ALLOWED_REGEX_FLAGS)}, each at most once`);
  }
  const source = `^(?:${pattern})$`;
  if (outlineTooLarge(source, flags)) {
    return refuse("too_complex", `program larger than ${MAX_PROGRAM_SIZE} instructions`);
  }
  let re: RE2JS;
  try {
    re = RE2JS.compile(`${inlineFlags(flags)}${source}`);
  } catch (cause) {
    return refuse(compilesInJavaScript(source, flags) ? "unsupported" : "syntax", String(cause));
  }
  if (re.programSize() > MAX_PROGRAM_SIZE) {
    return refuse("too_complex", `program larger than ${MAX_PROGRAM_SIZE} instructions`);
  }
  return re;
}

/**
 * Whether the program is over the bound, read before the engine BUILDS it. A
 * Unicode class (`\pL`, `\p{Greek}`) carries hundreds of ranges, copied by
 * every repetition: `\pL{1000}` nine times over took more memory to build
 * than the whole API may hold, before its size could be read. The outline
 * puts `.` in place of each — one instruction too, so the same size — and
 * is cheap to build. An outline that does not compile says nothing: the
 * pattern itself is compiled next and tells why.
 */
function outlineTooLarge(source: string, flags: string): boolean {
  const outline = source.replace(/\\\\|\\[pP](?:\{[^}]*\}|.)/g, (escape) => (escape === "\\\\" ? escape : "."));
  if (outline === source) return false;
  try {
    return RE2JS.compile(`${inlineFlags(flags)}${outline}`).programSize() > MAX_PROGRAM_SIZE;
  } catch {
    return false;
  }
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

/** Full match, on an input truncated to the D10 limit. An invalid pattern never matches. */
export function matchRegex(input: string, pattern: string, flags = "i"): boolean {
  const candidate = normalizeInput(input).slice(0, MAX_INPUT_LENGTH);
  try {
    return compileFullMatch(pattern, flags).test(candidate);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// number
// ---------------------------------------------------------------------------

export interface NumberOptions {
  unit?: string | undefined;
  unitRequired?: boolean | undefined;
}

/**
 * Parses a student-typed number: strips the unit suffix, the space and
 * apostrophe thousand separators, and accepts the French decimal comma.
 * Returns `null` when nothing usable is there.
 */
export function parseNumericInput(raw: string, opts: NumberOptions = {}): number | null {
  let s = applyTextOptions(normalizeInput(raw), { trim: true, collapseSpaces: true });
  const unit = opts.unit?.trim() ?? "";
  if (unit !== "") {
    const suffix = new RegExp(`\\s*${escapeRegExp(unit)}$`, "i");
    if (suffix.test(s)) s = s.replace(suffix, "");
    else if (opts.unitRequired === true) return null;
  }
  s = s.replace(/[\s'’]/g, "").replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function matchNumber(
  input: string,
  spec: { value: number; tolerance?: number | undefined; toleranceMode?: ToleranceMode | undefined } & NumberOptions,
): boolean {
  const parsed = parseNumericInput(input, spec);
  if (parsed === null) return false;
  return withinTolerance(parsed, spec.value, spec.tolerance ?? 0, spec.toleranceMode ?? "abs");
}

export function withinTolerance(
  actual: number,
  expected: number,
  tolerance: number,
  mode: ToleranceMode,
): boolean {
  const limit = mode === "rel" ? Math.abs(expected) * tolerance : tolerance;
  return Math.abs(actual - expected) <= limit + 1e-12;
}

// ---------------------------------------------------------------------------
// date / time
// ---------------------------------------------------------------------------

const DATE_FORMATS: RegExp[] = [
  /^(\d{4})-(\d{2})-(\d{2})$/,
  /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/,
];

/** Accepts `yyyy-mm-dd`, `dd.mm.yyyy` and `dd/mm/yyyy`; returns an ISO `yyyy-mm-dd`. */
export function parseDateInput(raw: string): string | null {
  const s = applyTextOptions(normalizeInput(raw), { trim: true, collapseSpaces: true }).replace(/\s/g, "");
  const iso = DATE_FORMATS[0]!.exec(s);
  const eu = DATE_FORMATS[1]!.exec(s);
  const parts = iso
    ? { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) }
    : eu
      ? { y: Number(eu[3]), m: Number(eu[2]), d: Number(eu[1]) }
      : null;
  if (parts === null) return null;
  const at = Date.UTC(parts.y, parts.m - 1, parts.d);
  const back = new Date(at);
  if (back.getUTCFullYear() !== parts.y || back.getUTCMonth() !== parts.m - 1 || back.getUTCDate() !== parts.d) {
    return null;
  }
  return `${pad(parts.y, 4)}-${pad(parts.m, 2)}-${pad(parts.d, 2)}`;
}

export function matchDate(input: string, value: string, toleranceDays = 0): boolean {
  const a = parseDateInput(input);
  const b = parseDateInput(value);
  if (a === null || b === null) return false;
  const days = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
  return days <= toleranceDays;
}

/** Accepts `hh:mm`, `hhhmm` and `hh h mm`; returns `HH:MM`. */
export function parseTimeInput(raw: string): string | null {
  const s = applyTextOptions(normalizeInput(raw), { trim: true, collapseSpaces: true });
  const m = /^(\d{1,2})\s*[:hH]\s*(\d{1,2})$/.exec(s);
  if (m === null) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${pad(h, 2)}:${pad(min, 2)}`;
}

export function matchTime(input: string, value: string, toleranceMinutes = 0): boolean {
  const a = parseTimeInput(input);
  const b = parseTimeInput(value);
  if (a === null || b === null) return false;
  return Math.abs(minutesOfDay(a) - minutesOfDay(b)) <= toleranceMinutes;
}

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// The matcher pipeline
// ---------------------------------------------------------------------------

/** Does this single matcher accept the (raw) student input? `llm` never does in the MVP. */
export function matchShort(input: string, matcher: ShortMatcher): boolean {
  switch (matcher.kind) {
    case "exact":
      return matchExact(input, matcher.value, matcher);
    case "regex":
      return matchRegex(input, matcher.pattern, matcher.flags ?? "i");
    case "number": {
      const { value, tolerance = 0 } = matcher;
      return typeof value === "number" && typeof tolerance === "number"
        ? matchNumber(input, { ...matcher, value, tolerance })
        : false;
    }
    case "date":
      return matchDate(input, matcher.value, matcher.toleranceDays ?? 0);
    case "time":
      return matchTime(input, matcher.value, matcher.toleranceMinutes ?? 0);
    case "llm":
      return false;
  }
}

export interface ShortMatchResult {
  matchedIndex: number | null;
  matchedKind: ShortMatcher["kind"] | null;
  normalized: string;
  fraction: number;
}

/**
 * Matchers are evaluated IN ORDER and the FIRST match wins, yielding
 * `fraction = matcher.points` (default 1). An empty or absent answer scores 0
 * without running a single matcher (F-GRADE-01).
 */
export function matchShortAnswer(
  raw: string | null,
  matchers: readonly ShortMatcher[],
): ShortMatchResult {
  const normalized = raw === null ? "" : applyTextOptions(normalizeInput(raw));
  if (normalized === "") return { matchedIndex: null, matchedKind: null, normalized, fraction: 0 };
  for (let i = 0; i < matchers.length; i++) {
    const matcher = matchers[i]!;
    if (matchShort(raw!, matcher)) {
      return { matchedIndex: i, matchedKind: matcher.kind, normalized, fraction: matcher.points ?? 1 };
    }
  }
  return { matchedIndex: null, matchedKind: null, normalized, fraction: 0 };
}

/** Human rendering of a matcher, for the solution panel. */
export function describeMatcher(matcher: ShortMatcher): string {
  switch (matcher.kind) {
    case "exact":
      return matcher.value;
    case "regex":
      return `/${matcher.pattern}/${matcher.flags ?? "i"}`;
    case "number": {
      const tolerance = matcher.tolerance ?? 0;
      const unit = matcher.unit === undefined ? "" : ` ${matcher.unit}`;
      if (tolerance === 0) return `${matcher.value}${unit}`;
      const rel = (matcher.toleranceMode ?? "abs") === "rel";
      const suffix = !rel ? String(tolerance) : typeof tolerance === "number" ? `${tolerance * 100} %` : `100 × ${tolerance} %`;
      return `${matcher.value} ± ${suffix}${unit}`;
    }
    case "date":
      return matcher.value;
    case "time":
      return matcher.value;
    case "llm":
      return matcher.rubric;
  }
}
