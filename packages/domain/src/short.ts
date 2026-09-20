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
 * 500, and the flags are restricted to `imsu`. Bounded input makes catastrophic
 * backtracking a worker-level slowdown at worst, never a request-path denial of
 * service — matchers run in the grading worker, not in the HTTP handler.
 */

/** Decision D10 limits. */
export const MAX_PATTERN_LENGTH = 300;
export const MAX_INPUT_LENGTH = 500;
export const ALLOWED_REGEX_FLAGS = /^[imsu]*$/;

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
      value: number;
      tolerance?: number | undefined;
      toleranceMode?: ToleranceMode | undefined;
      unit?: string | undefined;
      unitRequired?: boolean | undefined;
      points?: number | undefined;
    }
  | { kind: "date"; value: string; toleranceDays?: number | undefined; points?: number | undefined }
  | { kind: "time"; value: string; toleranceMinutes?: number | undefined; points?: number | undefined }
  | { kind: "llm"; rubric: string; reference?: string | undefined; points?: number | undefined };

/** A pattern that cannot be compiled, or that breaks a D10 limit. */
export class InvalidMatcherPattern extends Error {
  readonly code = "invalid_matcher_pattern";

  constructor(
    readonly pattern: string,
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

/**
 * Compiles a matcher pattern as a FULL match, the way the spec defines it.
 * Called at publication time so that an invalid pattern is a publication
 * error, never a grading-time surprise.
 */
export function compileFullMatch(pattern: string, flags = "i"): RegExp {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new InvalidMatcherPattern(pattern, `pattern longer than ${MAX_PATTERN_LENGTH} characters`);
  }
  if (!ALLOWED_REGEX_FLAGS.test(flags)) {
    throw new InvalidMatcherPattern(pattern, `flags must match ${String(ALLOWED_REGEX_FLAGS)}`);
  }
  try {
    return new RegExp(`^(?:${pattern})$`, flags);
  } catch (cause) {
    throw new InvalidMatcherPattern(pattern, cause instanceof Error ? cause.message : "syntax error");
  }
}

/** Publication-time validation: does this pattern compile within the D10 limits? */
export function isValidPattern(pattern: string, flags = "i"): boolean {
  try {
    compileFullMatch(pattern, flags);
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
    case "number":
      return matchNumber(input, matcher);
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

/** Phase 2 guard: a config holding an `llm` matcher is refused at publication. */
export function hasLlmMatcher(matchers: readonly ShortMatcher[]): boolean {
  return matchers.some((m) => m.kind === "llm");
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
      const suffix = (matcher.toleranceMode ?? "abs") === "rel" ? `${tolerance * 100} %` : String(tolerance);
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
