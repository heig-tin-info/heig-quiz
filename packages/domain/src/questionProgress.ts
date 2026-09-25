/**
 * Where a student stands on each question of an attempt (F-LIVE-08,
 * F-LIVE-09, F-DASH-01, issue #89) — a pure rule (invariant 8), because it is
 * read THREE times: by the `live` service, which refuses the writes and
 * builds the dashboard; by the player, which never offers a move the server
 * would refuse; and by the dashboard grid, which moves its cells from SSE
 * frames without asking the server again.
 *
 * Four facts are stored per question, and they are independent:
 *
 *   - ANSWERED: the question holds an answer. It is not a click: it is the
 *     question type's own notion of an empty answer (`isAnswered` of the
 *     type, server and client), read from the payload. This module receives
 *     it as a boolean and never looks at a payload;
 *   - SKIPPED ("I won't answer this question"): the student settled a
 *     question they deliberately leave blank. Writing an answer clears it;
 *     grading ignores it (an empty answer scores 0 either way);
 *   - FLAGGED ("review"): a note to self, orthogonal to the three others. No
 *     effect on grading; the teacher sees it on the live grid;
 *   - VALIDATED: the irreversible step of the locking navigations — "Validate
 *     and continue" in `forward_only`, crossing a checkpoint in
 *     `milestones`. Stored in `answers.marked_done`, the column that held the
 *     old "Mark as done" (which it replaces).
 *
 * The unions are spelled out rather than imported from `@quiz/contracts`
 * (the domain depends on nothing but `@quiz/core`); they are structurally the
 * types of the same names there.
 */

export type NavigationMode = "free" | "forward_only" | "milestones";

/** What the student's question list shows for one question. */
export type AnswerMark = "answered" | "skipped" | "unanswered";

/**
 * Answered wins over skipped: the two are never both stored for long (an
 * answer clears the skip), and if a race ever leaves both, what the question
 * HOLDS is what gets graded, so that is what the list says.
 */
export function answerMark(input: { answered: boolean; skipped: boolean }): AnswerMark {
  if (input.answered) return "answered";
  return input.skipped ? "skipped" : "unanswered";
}

/** A question the student has decided about: answered, or deliberately left. */
export function isSettled(input: { answered: boolean; skipped: boolean }): boolean {
  return answerMark(input) !== "unanswered";
}

/**
 * "I won't answer" is offered only on a question that holds nothing: on an
 * answered one it would mean "throw my answer away", which is a different
 * and destructive act (and, for multiple choice, the separate Clear).
 */
export function maySkip(input: { answered: boolean }): boolean {
  return !input.answered;
}

/**
 * Whether the question offers "Validate and continue": every question in
 * `forward_only`, the checkpoint questions in `milestones`, nothing in `free`
 * (where nothing is irreversible, so nothing needs validating).
 */
export function mayValidate(navigation: NavigationMode, item: { milestone: boolean }): boolean {
  if (navigation === "forward_only") return true;
  if (navigation === "milestones") return item.milestone;
  return false;
}

/**
 * Which items are closed to writing, and therefore to navigation
 * (F-EVAL-07). `items` is in the STUDENT's order.
 *
 *   - `free`: none;
 *   - `forward_only`: every validated question;
 *   - `milestones`: everything up to and including the furthest validated
 *     checkpoint.
 */
export function lockedItems(
  navigation: NavigationMode,
  items: readonly { id: string; milestone: boolean; validated: boolean }[],
): Set<string> {
  const locked = new Set<string>();
  if (navigation === "free") return locked;
  if (navigation === "forward_only") {
    for (const item of items) if (item.validated) locked.add(item.id);
    return locked;
  }
  let furthest = -1;
  items.forEach((item, rank) => {
    if (item.milestone && item.validated) furthest = rank;
  });
  items.forEach((item, rank) => {
    if (rank <= furthest) locked.add(item.id);
  });
  return locked;
}

/** The progress half of a dashboard cell (F-DASH-01). */
export type ProgressStatus = "empty" | "seen" | "in_progress" | "skipped" | "done";

/**
 * One cell's progress, from what is stored. `row` is false when the student
 * never opened the question (no `answers` row). A validated question reads
 * `done` whatever it holds: in the locking modes it is the furthest fact.
 * `in_progress` is kept as the name of "holds an answer" — it is what the
 * grid has always called the state the student wrote in.
 */
export function progressStatus(input: {
  row: boolean;
  answered: boolean;
  skipped: boolean;
  validated: boolean;
}): ProgressStatus {
  if (!input.row) return "empty";
  if (input.validated) return "done";
  const mark = answerMark(input);
  if (mark === "answered") return "in_progress";
  return mark === "skipped" ? "skipped" : "seen";
}

/**
 * Whether a cell counts toward a question's completion on the dashboard:
 * the student has DEALT with it — answered it, said they will not, or
 * validated it. Opening a question and leaving it (`seen`) is not progress.
 */
export function countsAsCompleted(status: ProgressStatus): boolean {
  return status === "in_progress" || status === "skipped" || status === "done";
}
