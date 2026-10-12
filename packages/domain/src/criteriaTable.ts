/**
 * The criteria table of a repository graded by criteria (ADR-106 §6): the
 * report, rendered on read from the current rows of
 * `project_criterion_grades` by ONE function with an audience — the
 * staff's grading screen (§8) and the student view (§9) — never stored.
 * A rationale is plain text: carried as the string it is, never turned into
 * markup here or anywhere (N-SEC-14's rule); the screens escape it.
 */
import { GRADING_SOURCES, GRADING_STATES } from "./batchable.js";
import { criteriaTotals, type CriteriaLeaf } from "./criteria.js";
import { EVIDENCE_STATUSES } from "./evidence.js";

/**
 * Why a criterion's row is a 0-point proposal (ADR-106 §3, §4): no
 * evidence (an evidence status), or the LLM pass failed (ADR-063 §2's
 * reasons). Staff only: a student never reads one (§9).
 */
export const CRITERION_REASONS = [
  ...EVIDENCE_STATUSES.filter((s) => s !== "ok"),
  "llm_budget",
  "llm_not_configured",
  "grader_error",
] as const;
export type CriterionReason = (typeof CRITERION_REASONS)[number];

/** A row's state in the table: none yet, indicative (a student's not-yet-final points), or the row's own. */
export const CRITERIA_TABLE_STATES = ["empty", "indicative", "proposed", "validated"] as const;
export type CriteriaTableState = (typeof CRITERIA_TABLE_STATES)[number];

export type CriteriaTableAudience = "staff" | "student";

/** A stored row, as the table reads it. */
export interface CriterionGradeLike {
  criterionId: string;
  points: number;
  source: (typeof GRADING_SOURCES)[number];
  state: (typeof GRADING_STATES)[number];
  rationale: string | null;
  reason: CriterionReason | null;
  createdAt: Date;
}

/** One line of the table. `source`, `reason` are the staff's only; `rationale` the student's only after the freeze. */
export interface CriteriaTableRow {
  criterionId: string;
  /** The section's dotted id (`rapport.reponses`); empty at the root. */
  section: string;
  description: string;
  max: number;
  /** A bonus criterion's points, on top of the maximum. */
  bonus?: number | undefined;
  points: number | null;
  state: CriteriaTableState;
  source?: (typeof GRADING_SOURCES)[number] | undefined;
  rationale?: string | undefined;
  reason?: CriterionReason | undefined;
}

export interface CriteriaTableOptions {
  audience: CriteriaTableAudience;
  /** The repository's definitive freeze has come. */
  frozen: boolean;
  /** The project is released. */
  released: boolean;
}

/** The row a criterion stands on: its validated row, else its newest proposal; a superseded row never. */
export function currentCriterionRows<R extends CriterionGradeLike>(rows: readonly R[]): Map<string, R> {
  const current = new Map<string, R>();
  for (const row of rows) {
    if (row.state === "superseded") continue;
    const held = current.get(row.criterionId);
    const better =
      !held ||
      (row.state === "validated" && held.state !== "validated") ||
      (row.state === held.state && row.createdAt.getTime() > held.createdAt.getTime());
    if (better) current.set(row.criterionId, row);
  }
  return current;
}

/**
 * The table, one line per criterion of the snapshot in its order. The
 * staff read each row's points, state, source, rationale and reason. A
 * student reads the points, every row not validated-and-released marked
 * `indicative`; the rationale only after the freeze — provisional until
 * the release, then from the validated rows only; never a source, a reason
 * or a superseded row (§9). Rows of a criterion the snapshot no longer
 * holds are left out.
 */
export function criteriaTable(
  snapshot: { leaves: readonly Pick<CriteriaLeaf, "id" | "sectionPath" | "description" | "maxPoints" | "bonusPoints">[] },
  rows: readonly CriterionGradeLike[],
  options: CriteriaTableOptions,
): CriteriaTableRow[] {
  const current = currentCriterionRows(rows);
  const staff = options.audience === "staff";
  return snapshot.leaves.map((leaf) => {
    const line: CriteriaTableRow = {
      criterionId: leaf.id,
      section: leaf.sectionPath.join("."),
      description: leaf.description,
      max: leaf.maxPoints,
      ...(leaf.bonusPoints === undefined ? {} : { bonus: leaf.bonusPoints }),
      points: null,
      state: "empty",
    };
    const row = current.get(leaf.id);
    if (!row) return line;
    line.points = row.points;
    if (staff) {
      line.state = row.state === "validated" ? "validated" : "proposed";
      line.source = row.source;
      if (row.rationale !== null) line.rationale = row.rationale;
      if (row.reason !== null) line.reason = row.reason;
      return line;
    }
    // A failed or missing pass graded nothing: obtained stays empty for a student until a teacher validates (§9).
    if (row.reason !== null && row.state !== "validated") {
      line.points = null;
      return line;
    }
    const final = row.state === "validated" && options.released;
    line.state = final ? "validated" : "indicative";
    const rationaleShown = options.frozen && (!options.released || row.state === "validated");
    if (rationaleShown && row.rationale !== null) line.rationale = row.rationale;
    return line;
  });
}

/** Where a repository's validation stands (ADR-106 §8). */
export interface RepoValidation {
  /** Every criterion of the snapshot has a current `validated` row. */
  validated: boolean;
  /** The criteria with no row at all: a teacher-only one waits for a teacher, never defaulted to 0. */
  missing: string[];
  /** The criteria whose current row is a proposal: Validate marks them validated. */
  proposed: string[];
}

/**
 * A repository is **validated** when every criterion of the snapshot has a
 * current `validated` row (ADR-106 §8): no repository state of its own. A
 * row of a criterion the snapshot no longer holds is not counted.
 */
export function repoValidation(snapshot: { leaves: readonly Pick<CriteriaLeaf, "id">[] }, rows: readonly CriterionGradeLike[]): RepoValidation {
  const current = currentCriterionRows(rows);
  const missing: string[] = [];
  const proposed: string[] = [];
  for (const { id } of snapshot.leaves) {
    const row = current.get(id);
    if (!row) missing.push(id);
    else if (row.state !== "validated") proposed.push(id);
  }
  return { validated: missing.length === 0 && proposed.length === 0, missing, proposed };
}

/**
 * The `criteria` final-score source of a repository (ADR-106 §7): the
 * total of its validated rows (`criteriaTotals`: the maximum is the sum of
 * the positive maxima, a penalty subtracted, a bonus on top, clamped) —
 * ONLY for a validated repository; null otherwise, never 0, so the final
 * score falls through to the review, frozen or current score. Null too for
 * a snapshot with no positive maximum: a score needs one.
 */
export function criteriaScore(
  snapshot: { leaves: readonly Pick<CriteriaLeaf, "id" | "maxPoints" | "bonusPoints">[] },
  rows: readonly CriterionGradeLike[],
): { points: number; max: number } | null {
  if (!repoValidation(snapshot, rows).validated) return null;
  const awarded: Record<string, number> = {};
  for (const [id, row] of currentCriterionRows(rows)) awarded[id] = row.points;
  const totals = criteriaTotals(snapshot.leaves, awarded);
  return totals.max > 0 ? { points: totals.points, max: totals.max } : null;
}
