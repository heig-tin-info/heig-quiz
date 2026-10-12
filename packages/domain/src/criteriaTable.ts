/**
 * The criteria table of a repository graded by criteria (ADR-106 §6): the
 * report, rendered on read from the current rows of
 * `project_criterion_grades` by ONE function with an audience — the
 * staff's grading screen (§8) and the student view (§9) — never stored.
 * A rationale is plain text: carried as the string it is, never turned into
 * markup here or anywhere (N-SEC-14's rule); the screens escape it.
 */
import { GRADING_SOURCES, GRADING_STATES } from "./batchable.js";
import type { CriteriaLeaf } from "./criteria.js";
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
function currentRows<R extends CriterionGradeLike>(rows: readonly R[]): Map<string, R> {
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
  const current = currentRows(rows);
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
