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
 *   - the progress states are not three. `seen` (opened, nothing typed)
 *     stays neutral, `in_progress` (it holds an answer) is the light blue and
 *     `done` (validated, in the locking navigations) is the filled one, so a
 *     column darkening downward IS the class moving through the quiz;
 *     `skipped` ("I won't answer", issue #89) is neutral and dashed — a
 *     decision, not progress through the answer;
 *   - "names off" shows a NUMBER, not the animal pseudonym, and the number
 *     must not leak the roster's alphabetical order (below).
 */
import type { DashboardCell, DashboardRow, Timing } from "@quiz/contracts";
import { countsAsCompleted } from "@quiz/domain";

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
    case "skipped":
      return "skipped";
    case "done":
      return "done";
  }
}

/**
 * The ONE clock of the header (#227, F-DASH-03), or null when the class has
 * none.
 *
 * In `deadline` timing it is the common close. In `duration` timing there is
 * no common close — a `closesAt` left on the evaluation is only the ticker's
 * latest close, which "+N min" never moves (#574), so it is not the clock — but a quiz the teacher STARTED begins every waiting
 * attempt at the same instant (`beginWaitingAttempts`), and pauses and
 * "+N min for all" move those deadlines together: the running rows share one
 * deadline, and that deadline is the class's clock. So it is the deadline
 * most running rows share — compared as instants, since the same moment may
 * be serialised two ways — provided at least two share it. Students who each
 * started on their own share none, and every row keeps its own countdown.
 */
export function commonDeadline(
  closesAt: string | null,
  rows: readonly DashboardRow[],
  timing?: Timing,
): string | null {
  if (closesAt !== null && timing !== "duration") return closesAt;
  const shared = new Map<number, { at: string; n: number }>();
  for (const row of rows) {
    if (row.state !== "in_progress" || row.deadlineAt === null) continue;
    const key = Date.parse(row.deadlineAt);
    const entry = shared.get(key);
    shared.set(key, { at: row.deadlineAt, n: (entry?.n ?? 0) + 1 });
  }
  let best: { at: string; n: number } | null = null;
  for (const entry of shared.values()) if (entry.n > (best?.n ?? 1)) best = entry;
  return best?.at ?? null;
}

/**
 * Whether a row's deadline is its own (F-DASH-03, #227): an individual
 * extension, a time bonus, a late start in `duration` mode (F-LIVE-12). The
 * header shows the common clock ({@link commonDeadline}), so only such a row
 * repeats a countdown. Compared as INSTANTS, and, when there is no common
 * clock, any deadline is the row's own. Whether the row is still running is
 * the caller's question, not this one.
 */
export function ownDeadline(
  deadlineAt: string | null,
  common: string | null,
): deadlineAt is string {
  if (deadlineAt === null) return false;
  return common === null || Date.parse(deadlineAt) !== Date.parse(common);
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
 * COUNTS as soon as the student has dealt with it — it holds an answer
 * (`in_progress`), they said they will not answer it (`skipped`), or they
 * validated it (`done`); `@quiz/domain#countsAsCompleted`, which the server
 * applies to the class totals too. `seen` does not count — opening a
 * question and leaving it blank is not progress — and neither does `empty`.
 * It is deliberately not the score: the grid says how much of the quiz has
 * been gone through, months before any of it is graded.
 */
export function completionOf(row: DashboardRow): { done: number; total: number; percent: number } {
  const total = row.cells.length;
  const done = row.cells.filter((c) => countsAsCompleted(c.status)).length;
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
  return new Map(order.map((row, index) => [row.seatId, index + 1]));
}
