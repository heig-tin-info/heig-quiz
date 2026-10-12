/**
 * A project's grading criteria (ADR-106 §2): the shape of a parsed
 * `criteria.yml` (StudentScore 0.7.5, schema v2), the closed codes of its
 * refusals, and the rules read from it — who proposes each criterion's
 * points ({@link classifyCriterion}), a repository's total
 * ({@link criteriaTotals}, StudentScore's `_clamp`), and what the grading
 * workflow says ({@link workflowTestsCriterion}, {@link workflowNeedsNetwork}).
 * No YAML here: the parser is `./criteriaParse.ts`
 * (`@quiz/domain/criteriaParse`), so these stay out of the web's bundle.
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
  /** `schema_version` 1 or absent: v1 is not supported yet. */
  "schema_v1",
  /** `schema_version` neither 1 nor 2. */
  "schema_version",
  "missing_criteria",
  "no_criteria",
  /** A section or criterion name holding a dot (two ids would collide). */
  "dotted_key",
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
  "missing_awarded",
  "both_points",
  "missing_points",
  /** `max_points` or `bonus_points` not an integer. */
  "not_integer",
  /** A percentage as a maximum: it only applies to `awarded_points`. */
  "percent_max",
  "zero_points",
  "negative_bonus",
  /** `awarded_points` a string that is not `42%`. */
  "bad_percent",
  "percent_range",
  "not_numeric",
  /** `awarded_points` out of the criterion's range (`params.awarded`, `params.max`). */
  "awarded_out_of_range",
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
  test?: string;
  milestone?: string;
}

export interface ParsedCriteria {
  schemaVersion: 2;
  grading: CriteriaGrading;
  sections: CriteriaSection[];
  leaves: CriteriaLeaf[];
}


/** `_MILESTONE_PATTERN`: the tag doubles as a CLI argument (`score grade --milestone <name>`). */
export const MILESTONE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,49}$/;
/** `tests-criterion: <id>` in a workflow's `with:` block, quoted or not. */
const TESTS_CRITERION_INPUT = /^\s*tests-criterion\s*:\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/m;

/**
 * The `tests-criterion` input a repository's grading workflow passes to
 * StudentScore's reusable workflow (ADR-106 §2): what pre-fills the
 * project's tests criterion. Null when the workflow does not set it.
 */
export function workflowTestsCriterion(workflowText: string): string | null {
  return TESTS_CRITERION_INPUT.exec(workflowText)?.[1] ?? null;
}

/** The workflow inputs that run commands on the CI's runner (StudentScore's reusable workflow). */
const COMMAND_INPUT = /^\s*(?:build-command|test-command|review-test-command)\s*:\s*(.*)$/gm;
/** A non-empty `apt-packages:` input. */
const APT_PACKAGES_INPUT = /^\s*apt-packages\s*:\s*["']?[^\s"'#]/m;
/** What needs the network: a package manager installing something. */
const INSTALLS = /\bpip3?\s+install\b|\bapt-get\b|\bapt\s/;

/**
 * Whether a repository's grading workflow needs the network to build or
 * test (ADR-106 §1): a non-empty `apt-packages` input, or a `pip install`,
 * an `apt-get` or an `apt` in its build, test or review-test command. The
 * platform's evidence run has none (`--network none`), so such a project
 * cannot be graded by criteria until its workflow drops it.
 */
export function workflowNeedsNetwork(workflowText: string): boolean {
  if (APT_PACKAGES_INPUT.test(workflowText)) return true;
  for (const [, command] of workflowText.matchAll(COMMAND_INPUT)) if (INSTALLS.test(command!)) return true;
  return false;
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

/** Who proposes a criterion's points (ADR-106 §2). */
export const CRITERION_KINDS = ["automatic", "llm", "teacher"] as const;
export type CriterionKind = (typeof CRITERION_KINDS)[number];

/**
 * `automatic` for the project's tests criterion or a criterion carrying
 * `test` — even with a `prompt`, the tests decide alone; `llm` for one with
 * a `prompt`; `teacher` otherwise (its points wait for the teacher alone:
 * a criterion that judges an identity carries no prompt, ADR-106).
 */
export function classifyCriterion(leaf: Pick<CriteriaLeaf, "id" | "prompt" | "test">, settings: { testsCriterion: string }): CriterionKind {
  if (leaf.id === settings.testsCriterion || leaf.test !== undefined) return "automatic";
  return leaf.prompt !== undefined ? "llm" : "teacher";
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
