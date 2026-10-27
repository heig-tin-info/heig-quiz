/**
 * A project's grading criteria (ADR-106 §2, schema 3 of the criteria-3
 * contract, ADR-119): the shape of a parsed `criteria.yml`, the closed codes
 * of its refusals, and the rules read from it — who proposes each
 * criterion's points ({@link classifyCriterion}), a check's points from its
 * `n/m` result ({@link checkPoints}), and a repository's total
 * ({@link criteriaTotals}, StudentScore's `_clamp`).
 * No YAML here: the parser is `./criteriaParse.ts`
 * (`@quiz/domain/criteriaParse`), so these stay out of the web's bundle;
 * `results.json` is read by `./checkResults.ts`.
 */

/**
 * Why a criteria file is refused: a CLOSED list of codes the web words in
 * each language (invariant 1), StudentScore's English being no contract.
 * The parser's own; the `project` module adds what reading the file from
 * GitHub can meet (`CRITERIA_READ_ERROR_CODES` of `@quiz/contracts`).
 */
export const CRITERIA_PARSE_ERROR_CODES = [
  /** The YAML does not parse (`params.line` when known). */
  "yaml_syntax",
  /** The document, `criteria`, a section or an entry is not a mapping. */
  "not_mapping",
  /** `schema_version` 1 or absent: v1 is not supported. */
  "schema_v1",
  /** `schema_version` neither 1, 2 nor 3. */
  "schema_version",
  "missing_criteria",
  "no_criteria",
  /** A section or criterion name holding a dot (two ids would collide). */
  "dotted_key",
  /** Schema 3: a section or criterion name holding a space. */
  "spaced_key",
  "unknown_key",
  /** A string, or a list of strings, was expected. */
  "not_text",
  /** A string was expected. */
  "not_string",
  /** A list of strings was expected. */
  "not_text_list",
  "missing_description",
  "both_descriptions",
  "bad_milestone",
  /** Schema 2: `awarded_points` missing. */
  "missing_awarded",
  "both_points",
  "missing_points",
  /** Schema 2: `max_points` or `bonus_points` not an integer. */
  "not_integer",
  /** Schema 2: a percentage as a maximum (it only applies to `awarded_points`). */
  "percent_max",
  /** Schema 3: `max_points` or `bonus_points` not a number (a percentage included: schema 3 has none). */
  "not_number",
  "zero_points",
  /** `bonus_points` below zero: a bonus is positive. */
  "negative_bonus",
  /** Schema 2: `awarded_points` a string that is not `42%`. */
  "bad_percent",
  "percent_range",
  "not_numeric",
  /** Schema 2: `awarded_points` out of the criterion's range (`params.awarded`, `params.max`). */
  "awarded_out_of_range",
  /** Schema 3: `command` not an argv of 1 to 20 strings, the first non-empty, none holding NUL (never a shell string). */
  "bad_command",
  /** Schema 3: a `grading.sources` entry with a wildcard: plain paths only. */
  "wildcard_source",
] as const;
export type CriteriaParseErrorCode = (typeof CRITERIA_PARSE_ERROR_CODES)[number];

/** One refusal of a criteria file: where (`criteria/rapport/reponses/max_points`), why, and the values the wording names. */
export interface CriteriaError<C extends string = CriteriaParseErrorCode> {
  path: string;
  code: C;
  params?: Record<string, string | number>;
}

/** The structured student profile of the `grading` block (`_validate_student`). */
export interface CriteriaStudent {
  level?: string;
  knows?: string[];
  learning?: string[];
}

/** The `grading` block: the LLM's context, the student's profile, the source globs it reads. */
export interface CriteriaGrading {
  context: string | null;
  student?: CriteriaStudent;
  sources: string[];
}

/** A section of the tree, for display: its dotted id, its path and its description. */
export interface CriteriaSection {
  id: string;
  path: string[];
  description: string | null;
}

/** A criterion (a leaf of the tree), under its dotted id (`rendu.all-tests-passed`). */
export interface CriteriaLeaf {
  id: string;
  sectionPath: string[];
  description: string;
  /** Its points: negative for a penalty, 0 for a bonus criterion. */
  maxPoints: number;
  /** A bonus criterion's points, added on top of the maximum. */
  bonusPoints?: number;
  prompt?: string;
  /** Its check (schema 3): an argv the CI runs from the directory of `criteria.yml`, never a shell string. Makes the criterion automatic. */
  command?: string[];
  /** Schema 2's `test` (a pytest selector, ADR-106 §2): makes the criterion automatic on the runner's evidence. Never in schema 3. */
  test?: string;
  milestone?: string;
}

export interface ParsedCriteria {
  /**
   * The file's schema, which picks the grading model: 2, the runner's
   * evidence and the project's tests and identity criteria (ADR-106); 3,
   * the CI's `results.json` for the `command` criteria (criteria-3 contract).
   */
  schemaVersion: 2 | 3;
  grading: CriteriaGrading;
  sections: CriteriaSection[];
  leaves: CriteriaLeaf[];
}

/** `_MILESTONE_PATTERN`: the tag doubles as a CLI argument (`score grade --milestone <name>`). */
export const MILESTONE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,49}$/;
/** The most words a schema-3 `command` has (StudentScore's `_MAX_COMMAND_ARGS`). */
export const COMMAND_MAX_ARGS = 20;
/** A schema-3 section or criterion name (StudentScore's `_NAME_PATTERN`): neither a dot nor a space. */
export const NAME_PATTERN = /^[^.\s]+$/;
/** A schema-3 source: a plain path, no wildcard (StudentScore's `_WILDCARD_PATTERN`, negated). */
export const PLAIN_SOURCE_PATTERN = /^[^*?[]*$/;
/** `tests-criterion: <id>` in a workflow's `with:` block, quoted or not (schema 2's workflow). */
const TESTS_CRITERION_INPUT = /^\s*tests-criterion\s*:\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/m;

/**
 * The `tests-criterion` input a repository's grading workflow passes to
 * StudentScore's reusable workflow (ADR-106 §2): what pre-fills the
 * project's tests criterion. Null when the workflow does not set it.
 *
 * Schema 2 only: removed with schema 2 (L-06g).
 */
export function workflowTestsCriterion(workflowText: string): string | null {
  return TESTS_CRITERION_INPUT.exec(workflowText)?.[1] ?? null;
}

/** The programs that fetch from the network: package managers, downloaders, git. */
const NETWORK_PROGRAMS = new Set(["pip", "pip3", "apt", "apt-get", "apk", "npm", "pnpm", "yarn", "curl", "wget", "git"]);

/**
 * Whether a command the platform runs needs the network (ADR-106 §1): its
 * program — the argv's first word, by its base name — is a package manager,
 * a downloader or git, or it is `python -m pip`. The platform's evidence
 * run has none (`--network none`), so a project's build or test command
 * must not be one; the CI's own workflow may install what it needs.
 *
 * Schema 2 only (the runner's evidence): removed with schema 2 (L-06g).
 */
export function commandNeedsNetwork(argv: readonly string[]): boolean {
  // An argv has at least one word (`ProjectArgv`).
  const program = argv[0]!.split("/").pop()!;
  if (NETWORK_PROGRAMS.has(program)) return true;
  return /^python[0-9.]*$/.test(program) && argv[1] === "-m" && (argv[2] === "pip" || argv[2] === "pip3");
}

// ---------------------------------------------------------------- classification and totals

/**
 * The checkpoints whose name tags no criterion of `leaves` (ADR-106 §5): in
 * `criteria` mode a checkpoint is a milestone, its name the `milestone:` tag
 * of the criteria it grades — a snapshot leaving one of them untagged is
 * refused (`409 checkpoint_untagged`).
 */
export function untaggedCheckpoints(checkpointNames: readonly string[], leaves: readonly Pick<CriteriaLeaf, "milestone">[]): string[] {
  const tags = new Set(leaves.map((leaf) => leaf.milestone));
  return checkpointNames.filter((name) => !tags.has(name));
}

/**
 * The criteria a pass grades (ADR-106 §5): a milestone pass, those its
 * checkpoint's name tags only — the automatic one included when tagged;
 * the final pass (`milestone` null), every one.
 */
export function passLeaves<L extends Pick<CriteriaLeaf, "milestone">>(leaves: readonly L[], milestone: string | null): L[] {
  return milestone === null ? [...leaves] : leaves.filter((leaf) => leaf.milestone === milestone);
}

/** Who proposes a criterion's points (ADR-106 §2). */
export const CRITERION_KINDS = ["automatic", "llm", "teacher"] as const;
export type CriterionKind = (typeof CRITERION_KINDS)[number];

/**
 * The project's settings a schema-2 criterion's kind reads: its tests
 * criterion and its identity criterion (null: none). Schema 3 has neither
 * (removed with schema 2, L-06g).
 */
export interface CriterionSettings {
  testsCriterion: string;
  identityCriterion: string | null;
}

/**
 * Who proposes a criterion's points: `automatic` for one carrying a
 * `command` (schema 3) — even with a `prompt`, the check decides alone;
 * `llm` for one with a `prompt`; `teacher` otherwise.
 *
 * `schema2`: the project's settings for a schema-2 snapshot, null for a
 * schema-3 one — every caller chooses (ADR-106 §2): with them, the
 * project's tests criterion, its identity criterion (graded from the
 * commits' metadata, an identity never sent to the model) and a leaf
 * carrying `test` are automatic too.
 */
export function classifyCriterion(
  leaf: Pick<CriteriaLeaf, "id" | "prompt" | "command" | "test">,
  schema2: CriterionSettings | null,
): CriterionKind {
  if (leaf.command !== undefined) return "automatic";
  if (schema2 && (leaf.id === schema2.testsCriterion || leaf.id === schema2.identityCriterion || leaf.test !== undefined)) return "automatic";
  return leaf.prompt !== undefined ? "llm" : "teacher";
}

// ---------------------------------------------------------------- a check's result

/** A check's result as `results.json` writes it (ADR-119 §4): `n/m`, `n` and `m` decimal, spaces allowed around each, `m` positive. */
export const CHECK_SCORE_PATTERN = /^\s*\d+(\.\d+)?\s*\/\s*(0*[1-9]\d*(\.\d+)?|0*\.0*[1-9]\d*)\s*$/;

/** A parsed `n/m`. */
export interface CheckScore {
  n: number;
  m: number;
}

/**
 * Reads `n/m`; null when it does not match {@link CHECK_SCORE_PATTERN} or
 * a number does not read as a finite one (a 400-digit `n`, a denominator
 * that underflows to 0): the result is then
 * invalid, as if absent.
 */
export function parseCheckScore(text: string): CheckScore | null {
  if (!CHECK_SCORE_PATTERN.test(text)) return null;
  const [n, m] = text.split("/").map(Number) as [number, number];
  // The pattern says `m > 0`; a 400-digit number is infinite, and a denominator below 1e-324 reads as 0.
  return Number.isFinite(n) && Number.isFinite(m) && m > 0 ? { n, m } : null;
}

/** The fraction a check earned: `n` clamped to `[0, m]`, over `m`. */
export function checkFraction({ n, m }: CheckScore): number {
  return Math.max(0, Math.min(n, m)) / m;
}

/**
 * Points rounded to 0.01, half away from zero: `-2.625` gives `-2.63`, where
 * `Math.round` would give `-2.62`. The product is first read at 15
 * significant digits, so a binary artefact (`1.005 × 100 = 100.4999…`)
 * rounds as its decimal does. Never `-0`.
 */
export function roundPoints(value: number): number {
  const cents = Math.round(Number((Math.abs(value) * 100).toPrecision(15)));
  return cents === 0 ? 0 : (Math.sign(value) * cents) / 100;
}

/**
 * A criterion's points for a check's fraction `f` (criteria-3 contract):
 * a positive criterion earns `max × f`, a penalty (negative max)
 * `max × (1 − f)` — a passed check costs nothing —, a bonus `bonus × f`;
 * rounded by {@link roundPoints}. `f` is {@link checkFraction}'s, in `[0, 1]`.
 */
export function checkPoints(leaf: Pick<CriteriaLeaf, "maxPoints" | "bonusPoints">, f: number): number {
  if (leaf.bonusPoints !== undefined) return roundPoints(leaf.bonusPoints * f);
  return roundPoints(leaf.maxPoints < 0 ? leaf.maxPoints * (1 - f) : leaf.maxPoints * f);
}

/** A criterion's points clamped into its range (`_clamp` of `apply.py`): `[0, max]`, `[max, 0]` for a penalty, `[0, bonus]`. */
export function clampAwarded(leaf: Pick<CriteriaLeaf, "maxPoints" | "bonusPoints">, points: number): number {
  const [low, high] = awardedRange(leaf);
  return Math.max(low, Math.min(high, points));
}

/** A criterion's range of points, `[low, high]`: `[0, max]`, `[max, 0]` for a penalty, `[0, bonus]` for a bonus. */
export function awardedRange(leaf: Pick<CriteriaLeaf, "maxPoints" | "bonusPoints">): [number, number] {
  const top = leaf.bonusPoints ?? leaf.maxPoints;
  return top >= 0 ? [0, top] : [top, 0];
}

export interface CriteriaTotals {
  /** The points, clamped to `[0, max + bonusMax]`. */
  points: number;
  /** The sum of the positive maxima: a penalty and a bonus are not in it. */
  max: number;
  bonusMax: number;
  /** The criteria with no points yet (counted 0). */
  missing: string[];
}

/**
 * A repository's total from its criteria's points (StudentScore's
 * semantics): each clamped into its range, a penalty subtracted, a bonus
 * added on top, the total clamped to `[0, max + bonusMax]`.
 */
export function criteriaTotals(
  leaves: readonly Pick<CriteriaLeaf, "id" | "maxPoints" | "bonusPoints">[],
  awarded: Record<string, number | null | undefined>,
): CriteriaTotals {
  let points = 0;
  let max = 0;
  let bonusMax = 0;
  const missing: string[] = [];
  for (const leaf of leaves) {
    if (leaf.maxPoints > 0) max += leaf.maxPoints;
    bonusMax += leaf.bonusPoints ?? 0;
    const given = awarded[leaf.id];
    if (given === null || given === undefined) missing.push(leaf.id);
    else points += clampAwarded(leaf, given);
  }
  return { points: Math.max(0, Math.min(max + bonusMax, points)), max, bonusMax, missing };
}
