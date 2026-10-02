/**
 * What of a project may still change, and why not (F-PROJ-03, ADR-048,
 * merge task M3-02). The rule follows the spec, not heig-classroom:
 *
 * - a **draft** is freely editable;
 * - once published, only the name, the protected files, the deadline and
 *   the deadline strategy (until the deadline) change;
 * - the publication mode and its duration freeze at publication
 *   (`publish_mode_frozen`); the deadline strategy at the deadline
 *   (`strategy_frozen`); everything else at publication (`not_draft`): the
 *   start, the grace, the grading mode and scale, the group mode and size;
 * - a deadline already applied still moves, to a later date (the service
 *   refuses one already past, `deadline_past`): that **reopens** the
 *   project (F-PROJ-09, merge task M3-05a).
 *
 * The source repository, its branches and the source strategy are not in
 * the list at all: they are fixed at creation (product owner, 2026-10-02;
 * delete the draft and create it again to change them).
 *
 * `now` is the server's clock (invariant 5), never read here.
 */

/** The fields `ProjectPatch` may carry, in the form's order. */
export const PROJECT_PATCH_FIELDS = [
  "name",
  "publishMode",
  "startAt",
  "deadlineAt",
  "durationMinutes",
  "graceMinutes",
  "deadlineStrategy",
  "gradingMode",
  "gradingScale",
  "protectedFiles",
  "groupMode",
  "groupMaxSize",
] as const;
export type ProjectPatchField = (typeof PROJECT_PATCH_FIELDS)[number];

/** Why a field cannot change now: the code of the 409. */
export type ProjectFieldRefusal = "not_draft" | "publish_mode_frozen" | "strategy_frozen";

/** The facts of a project the rule reads. */
export interface ProjectLifeLike {
  state: "draft" | "published" | "locked";
  deadlineAt: Date;
}

/** Why `field` of `project` cannot change at `now`, or null when it may. */
export function projectFieldRefusal(
  project: ProjectLifeLike,
  field: ProjectPatchField,
  now: Date,
): ProjectFieldRefusal | null {
  if (project.state === "draft") return null;
  // `locked` is the deadline applied: a reopen makes it `published` again (M3-05a).
  const applied = project.state === "locked";
  switch (field) {
    case "name":
    case "protectedFiles":
    case "deadlineAt":
      return null;
    case "deadlineStrategy":
      return applied || now.getTime() >= project.deadlineAt.getTime() ? "strategy_frozen" : null;
    case "publishMode":
    case "durationMinutes":
      return "publish_mode_frozen";
    default:
      return "not_draft";
  }
}

/** The fields of `project` that may change at `now` (`ProjectSummary.editable`). */
export function editableProjectFields(project: ProjectLifeLike, now: Date): ProjectPatchField[] {
  return PROJECT_PATCH_FIELDS.filter((field) => projectFieldRefusal(project, field, now) === null);
}
