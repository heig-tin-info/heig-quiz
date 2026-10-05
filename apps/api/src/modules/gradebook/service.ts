/**
 * The `gradebook` module's entry (F-GBOOK, D06, ADR-074; merge task
 * M5-03a): one table per classroom — a column per released-or-not exam,
 * exercise or graded project, a row per claimed student seat — read from the
 * activities' own results and never recomputed, with the staff's settings
 * (weights, what counts, the published mean) and marks (an absence, a score)
 * stored here and nowhere else.
 *
 * - `table.ts`: the staff's table and the student's own cells (the student
 *   exit of the gradebook, spec 05 §5.7);
 * - `writes.ts`: the audited staff writes;
 * - `columns.ts`: what is stored beside the activities;
 * - the activities' columns and cells come through the `ActivityKind`
 *   registry (`modules/activity/`), so this module imports neither
 *   `results` nor `project` directly.
 *
 * The CSV export (F-GBOOK-04, M5-03b) is `csv.ts`, served by `routes.ts` from
 * the staff's table.
 */
export { GradebookError } from "./errors.js";
export { gradebookChanged } from "./events.js";
export { staffGradebook, studentGradebook } from "./table.js";
export { clearMark, patchColumn, patchSettings, setMark, type RoomScope, type WriteContext } from "./writes.js";
