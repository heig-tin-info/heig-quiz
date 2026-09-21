/*
 * How one cell — and one row — of the read model becomes one cell, one
 * number and one name of the grid.
 *
 * Four decisions live here and nowhere else:
 *   - the "results" toggle is what turns a PROGRESS cell into a VERDICT cell.
 *     Until a grading exists, `verdict` is null on every cell, so the toggle
 *     changes nothing — and the day it does, it changes it in one place;
 *   - the "answers" toggle decides whether the cell carries the student's
 *     answer in a glyph or two. Hiding answers must hide them, not grey them:
 *     the teacher turns it off precisely because the screen is projected;
 *   - the four progress states are not three. `seen` (opened, nothing typed)
 *     stays neutral, `in_progress` (something written) is the light blue and
 *     `done` (the student marked it done) is the filled one, so a column
 *     darkening downward IS the class moving through the quiz;
 *   - "names off" shows a NUMBER, not the animal pseudonym, and the number
 *     must not leak the roster's alphabetical order (below).
 */
import type { DashboardCell, DashboardRow } from "@quiz/contracts";

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
      return "inProgress";
    case "in_progress":
      return "answered";
    case "done":
      return "done";
  }
}

/** The glyph beside the icon, or nothing when the answers are hidden. */
export function cellValue(cell: DashboardCell, showAnswers: boolean): string | undefined {
  if (!showAnswers) return undefined;
  return cell.summary ?? undefined;
}

/**
 * How far one student has got, as a fraction of the questions.
 *
 * The rule, so that nobody has to guess it from the arithmetic: a question
 * COUNTS as soon as the student has written something in it (`in_progress`)
 * or marked it done (`done`). `seen` does not count — opening a question and
 * leaving it blank is not progress — and neither does `empty`. It is
 * deliberately not the score: the grid says how much of the quiz has been
 * gone through, months before any of it is graded.
 */
export function completionOf(row: DashboardRow): { done: number; total: number; percent: number } {
  const total = row.cells.length;
  const done = row.cells.filter((c) => c.status === "in_progress" || c.status === "done").length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/**
 * The number each row wears when the names are hidden (F-DASH-02, D20).
 *
 * "Student 1, Student 2, …" and not "Skilled Manatee": in front of a class a
 * teacher says a number out loud, and an animal is a second thing to read on
 * a projected grid. But a number in ROSTER order would hand the anonymity
 * straight back — the roster is alphabetical, so "Student 1" would be the
 * first surname of the class on every screen, in the grading panel, forever.
 *
 * So the order is the one thing on the row that is already a stable,
 * per-evaluation hash of the user id: the server's `pseudonym`. Sorting by it
 * shuffles the class deterministically. The number is therefore stable for
 * the whole evaluation, identical on a reload and for a colleague, and says
 * nothing about anyone's name.
 */
export function anonymousNumbers(rows: readonly DashboardRow[]): Map<string, number> {
  const order = [...rows].sort((a, b) => a.pseudonym.localeCompare(b.pseudonym, "en"));
  return new Map(order.map((row, index) => [row.userId, index + 1]));
}
