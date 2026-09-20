/*
 * How one cell of the read model becomes one cell of the grid.
 *
 * Two decisions live here and nowhere else:
 *   - the "results" toggle is what turns a PROGRESS cell into a VERDICT cell.
 *     Until WP6 writes the gradings, `verdict` is null on every cell (WP5
 *     deviation W5-20), so the toggle currently changes nothing — and the day
 *     it does, it changes it in one place;
 *   - the "answers" toggle decides whether the cell carries the student's
 *     answer in a glyph or two. Hiding answers must hide them, not grey them:
 *     the teacher turns it off precisely because the screen is projected.
 */
import type { DashboardCell } from "@quiz/contracts";

import type { VerdictState } from "../ui";

export function cellState(cell: DashboardCell, showResults: boolean): VerdictState {
  if (showResults && cell.verdict !== null) return cell.verdict === "correct"
    ? "correct"
    : cell.verdict === "partial"
      ? "partial"
      : cell.verdict === "wrong"
        ? "wrong"
        : "pending";
  switch (cell.status) {
    case "empty":
      return "blank";
    case "seen":
    case "in_progress":
      return "inProgress";
    case "done":
      return "answered";
  }
}

/** The glyph beside the icon, or nothing when the answers are hidden. */
export function cellValue(cell: DashboardCell, showAnswers: boolean): string | undefined {
  if (!showAnswers) return undefined;
  return cell.summary ?? undefined;
}
