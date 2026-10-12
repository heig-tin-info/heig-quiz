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
 *   start, the grace, the grading mode and scale, the group mode and the
 *   group set it follows (ADR-070 §7: the set freezes, its groups keep
 *   following);
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
import type { ProjectGradingModeName, ProjectStateName } from "./projectView.js";

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
  "groupSetId",
  // Grading by criteria (ADR-106 §2): editable in any state.
  "testsCriterion",
  "identityCriterion",
  "buildCommand",
  "testCommand",
  "evidenceOutputs",
] as const;
export type ProjectPatchField = (typeof PROJECT_PATCH_FIELDS)[number];

/** Why a field cannot change now: the code of the 409. */
export type ProjectFieldRefusal = "not_draft" | "publish_mode_frozen" | "strategy_frozen" | "released";

/** The facts of a project the rule reads. */
export interface ProjectLifeLike {
  state: ProjectStateName;
  deadlineAt: Date;
  /** The scores were released (`released_at`). */
  released: boolean;
  gradingMode: ProjectGradingModeName;
}

/**
 * Why `field` of `project` cannot change at `now`, or null when it may.
 * `value` is the patched value, which the grading mode's rule reads
 * ({@link gradingModeRefusal}); without it, whether the field may change
 * at all (`editable`).
 */
export function projectFieldRefusal(
  project: ProjectLifeLike,
  field: ProjectPatchField,
  now: Date,
  value?: unknown,
): ProjectFieldRefusal | null {
  if (project.state === "draft") return null;
  // `locked` is the deadline applied: a reopen makes it `published` again (M3-05a).
  const applied = project.state === "locked";
  switch (field) {
    case "name":
    case "protectedFiles":
    case "deadlineAt":
    case "testsCriterion":
    case "identityCriterion":
    case "buildCommand":
    case "testCommand":
    case "evidenceOutputs":
      return null;
    case "deadlineStrategy":
      return applied || now.getTime() >= project.deadlineAt.getTime() ? "strategy_frozen" : null;
    case "publishMode":
    case "durationMinutes":
      return "publish_mode_frozen";
    case "gradingMode":
      return gradingModeRefusal(project, value as ProjectGradingModeName | undefined);
    default:
      return "not_draft";
  }
}

/**
 * Why a project's grading mode cannot become `to` (F-PROJ-03 as amended by
 * ADR-106 §1), or null when it may: any mode on a draft; past it, one
 * deliberate exception — into or out of `criteria` on a `locked` project not
 * yet released (the pilot). Never on a `published` project (`not_draft`),
 * never after the release (`released`). Without `to`: whether the mode may
 * change at all.
 */
export function gradingModeRefusal(
  project: Pick<ProjectLifeLike, "state" | "released" | "gradingMode">,
  to?: ProjectGradingModeName,
): "not_draft" | "released" | null {
  if (project.state === "draft") return null;
  if (project.state !== "locked") return "not_draft";
  if (project.released) return "released";
  return to === undefined || to === "criteria" || project.gradingMode === "criteria" ? null : "not_draft";
}

/** The fields of `project` that may change at `now` (`ProjectSummary.editable`). */
export function editableProjectFields(project: ProjectLifeLike, now: Date): ProjectPatchField[] {
  return PROJECT_PATCH_FIELDS.filter((field) => projectFieldRefusal(project, field, now) === null);
}

// ---------------------------------------------------------------- a draft's dates

/** Why a patch leaves the dates incoherent: the first two are 422s, the others 400s. */
export type PatchedDatesRefusal = "deadline_past" | "start_past" | "duration_needs_manual" | "deadline_before_start";

/** The dates and the publication of a project, as stored. */
export interface ProjectDatesLike {
  publishMode: "manual" | "scheduled";
  startAt: Date;
  deadlineAt: Date;
  durationMinutes: number | null;
}

/** What a patch CHANGES of them (a field whose value is the stored one is left out). */
export type ProjectDatesChange = Partial<ProjectDatesLike>;

/**
 * The dates a patch leaves (F-PROJ-03), or why it cannot:
 *
 * - a duration on a manual draft keeps a provisional deadline, `now` plus
 *   the duration (Publish counts it again);
 * - back to a manual publication, the start is the publication's: it becomes
 *   `now`, so no phantom scheduled start blocks a later deadline;
 * - a deadline moved, or kept through the switch to manual, must lie ahead
 *   (`deadline_past`): a stale scheduled draft is not flipped to manual;
 * - a scheduled start must lie ahead when the mode or the start changed
 *   (`start_past`), else the ticker would publish it at the next tick;
 * - a duration only goes with a manual publication, and the deadline comes
 *   after the start.
 *
 * `now` is the server's clock (invariant 5).
 */
export function patchedDraftDates(
  project: ProjectDatesLike,
  changed: ProjectDatesChange,
  now: Date,
): { ok: true; startAt: Date; deadlineAt: Date } | { ok: false; refusal: PatchedDatesRefusal } {
  const publishMode = changed.publishMode ?? project.publishMode;
  const durationMinutes = changed.durationMinutes === undefined ? project.durationMinutes : changed.durationMinutes;
  const toManual = changed.publishMode === "manual";
  let startAt = changed.startAt ?? project.startAt;
  let deadlineAt = changed.deadlineAt ?? project.deadlineAt;
  if (changed.durationMinutes !== undefined && durationMinutes !== null) {
    deadlineAt = new Date(now.getTime() + durationMinutes * 60_000);
  }
  if (toManual) startAt = now;
  const deadlineMoved = changed.deadlineAt !== undefined || toManual;
  if (deadlineMoved && deadlineAt.getTime() <= now.getTime()) return { ok: false, refusal: "deadline_past" };
  if (publishMode === "scheduled" && durationMinutes !== null) return { ok: false, refusal: "duration_needs_manual" };
  if (publishMode === "scheduled" && (changed.publishMode !== undefined || changed.startAt !== undefined) && startAt.getTime() <= now.getTime()) {
    return { ok: false, refusal: "start_past" };
  }
  if (deadlineAt.getTime() <= startAt.getTime()) return { ok: false, refusal: "deadline_before_start" };
  return { ok: true, startAt, deadlineAt };
}
