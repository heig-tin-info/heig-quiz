/*
 * The new project form's rules (F-PROJ-01, M3-11), pure: what the form
 * holds, the body it sends — parsed by the very `ProjectCreate` the route
 * parses (invariant 7) —, the fields that body is still missing, and where
 * each refusal of the server is said. `NewProjectPage.tsx` draws them.
 */
import {
  PROJECT_DEFAULTS,
  ProjectCreate,
  ProjectRefusal,
  type DeadlineStrategy,
  type ProjectGradingMode,
  type ProjectSourceDetail,
  type PublishMode,
  type SourceStrategy,
} from "@quiz/contracts";
import { SCHOOL_TIME_ZONE, type ProjectScaleKind } from "@quiz/domain";

import { ApiError } from "../api";
import { fromLocalInput } from "../evaluation/timing";
import type { Dict } from "../i18n";
import { localTimeZone } from "../ui";

/** What the teacher fills in. Strings where an input holds one: the form keeps what was typed. */
export interface ProjectDraft {
  name: string;
  sourceRepo: string;
  /** In the order chosen, the first the students' default; null: the source's default branch. */
  branches: string[] | null;
  publishMode: PublishMode;
  /** A manual publication's deadline: a date, or a number of days counted from the publication. */
  deadlineKind: "date" | "duration";
  /** `datetime-local` values, in the browser's zone. */
  startLocal: string;
  deadlineLocal: string;
  durationDays: string;
  graceMinutes: string;
  sourceStrategy: SourceStrategy;
  deadlineStrategy: DeadlineStrategy;
  gradingMode: ProjectGradingMode;
  scaleKind: ProjectScaleKind;
  /** null: the source's suggestions (`suggestedProtected`), the default even while Advanced stays folded. */
  protectedFiles: string[] | null;
  groupMode: boolean;
  /** The classroom's group set a group project follows (ADR-070 §7); sent only in group mode. */
  groupSetId: string | null;
}

export const emptyDraft = (): ProjectDraft => ({
  name: "",
  sourceRepo: "",
  branches: null,
  publishMode: PROJECT_DEFAULTS.publishMode,
  deadlineKind: "date",
  startLocal: "",
  deadlineLocal: "",
  durationDays: "",
  graceMinutes: String(PROJECT_DEFAULTS.graceMinutes),
  sourceStrategy: PROJECT_DEFAULTS.sourceStrategy,
  deadlineStrategy: PROJECT_DEFAULTS.deadlineStrategy,
  gradingMode: PROJECT_DEFAULTS.gradingMode,
  scaleKind: "linear",
  protectedFiles: null,
  groupMode: false,
  groupSetId: null,
});

/** The fields a message can stand under, and the DOM id of each control (focus, `fieldErrorProps`). */
export const FIELD_ID = {
  name: "project-name",
  source: "project-source",
  start: "project-start",
  deadline: "project-deadline",
  duration: "project-duration",
  grace: "project-grace",
  groupSet: "project-group-set",
} as const;
export type ProjectField = keyof typeof FIELD_ID;

/** The branches handed out: the ones chosen that the source still has, else its default branch. */
export function chosenBranches(draft: ProjectDraft, detail: ProjectSourceDetail): string[] {
  const kept = (draft.branches ?? []).filter((b) => detail.branches.includes(b));
  return kept.length > 0 ? kept : [detail.defaultBranch];
}

/** The protected files sent: those chosen, or the source's suggestions. */
export const chosenProtected = (draft: ProjectDraft, detail: ProjectSourceDetail): string[] =>
  draft.protectedFiles ?? [...detail.suggestedProtected];

/** A count typed in a field: an integer, or undefined when it is empty or not one. */
function count(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

/** The body before the schema, every empty or unreadable value left out (the schema then names it). */
function rawBody(draft: ProjectDraft, detail: ProjectSourceDetail | undefined): Record<string, unknown> {
  const days = count(draft.durationDays);
  return {
    name: draft.name,
    sourceRepo: draft.sourceRepo,
    ...(detail ? { branches: chosenBranches(draft, detail), protectedFiles: chosenProtected(draft, detail) } : {}),
    publishMode: draft.publishMode,
    ...(draft.publishMode === "scheduled" ? { startAt: fromLocalInput(draft.startLocal) ?? undefined } : {}),
    ...(byDuration(draft)
      ? { durationMinutes: days === undefined ? Number.NaN : days * 1440 }
      : { deadlineAt: fromLocalInput(draft.deadlineLocal) ?? undefined }),
    graceMinutes: count(draft.graceMinutes) ?? Number.NaN,
    sourceStrategy: draft.sourceStrategy,
    deadlineStrategy: draft.deadlineStrategy,
    gradingMode: draft.gradingMode,
    gradingScale: { kind: draft.scaleKind },
    groupMode: draft.groupMode,
    // Never outside group mode: `ProjectCreate` refuses a set on an individual project.
    ...(draft.groupMode && draft.groupSetId ? { groupSetId: draft.groupSetId } : {}),
  };
}

/** A manual publication whose deadline is counted from it: the one case with a duration, and never a start. */
export const byDuration = (draft: ProjectDraft): boolean =>
  draft.publishMode === "manual" && draft.deadlineKind === "duration";

/** The schema's paths, as the fields that show them. */
const FIELD_OF: Record<string, ProjectField> = {
  name: "name",
  sourceRepo: "source",
  branches: "source",
  protectedFiles: "source",
  startAt: "start",
  deadlineAt: "deadline",
  durationMinutes: "duration",
  graceMinutes: "grace",
  groupSetId: "groupSet",
};

/** What a field says when the schema refuses it, in the teacher's words. */
function fieldMessage(field: ProjectField, draft: ProjectDraft): keyof Dict {
  return field === "deadline" && fromLocalInput(draft.deadlineLocal) !== null
    ? "project.missing.deadlineOrder"
    : `project.missing.${field}`;
}

/**
 * The body `POST …/projects` takes, or the fields still to fix. With a
 * source picked, the caller passes its detail (the branches and the
 * protected files sent by default); it refuses to send without it.
 */
export function projectBody(
  draft: ProjectDraft,
  detail: ProjectSourceDetail | undefined,
): { body: ProjectCreate; missing: null } | { body: null; missing: Partial<Record<ProjectField, keyof Dict>> } {
  const parsed = ProjectCreate.safeParse(rawBody(draft, detail));
  const missing: Partial<Record<ProjectField, keyof Dict>> = {};
  // The dates the schema's cross-field rule checks, said at once: that rule
  // only runs once every field of the body parses.
  if (draft.publishMode === "scheduled" && fromLocalInput(draft.startLocal) === null) missing.start = "project.missing.start";
  if (byDuration(draft)) {
    if (count(draft.durationDays) === undefined) missing.duration = "project.missing.duration";
  } else if (fromLocalInput(draft.deadlineLocal) === null) {
    missing.deadline = "project.missing.deadline";
  }
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = FIELD_OF[String(issue.path[0])];
      if (field && !missing[field]) missing[field] = fieldMessage(field, draft);
    }
  }
  if (parsed.success && Object.keys(missing).length === 0) return { body: parsed.data, missing: null };
  return { body: null, missing };
}

/**
 * Where a refused create is said (decided 2026-10-02): on the field it is
 * about, as a state of the page (the classroom is not connected), or above
 * the form — the build failed, the values stay for a retry. `null`: not a
 * refusal of the lifecycle, the ordinary server failure.
 */
export type RefusalPlace =
  | { at: "field"; field: ProjectField; message: keyof Dict; branches?: string[] }
  | { at: "page"; code: "not_connected" | "app_not_installed" }
  | { at: "form"; message: keyof Dict };

export function refusalPlace(error: unknown): RefusalPlace | null {
  if (!(error instanceof ApiError)) return null;
  const refusal = ProjectRefusal.safeParse(error.body);
  if (!refusal.success) return null;
  const { error: code, branches } = refusal.data;
  switch (code) {
    case "not_connected":
    case "app_not_installed":
      return { at: "page", code };
    case "source_not_found":
      return branches && branches.length > 0
        ? { at: "field", field: "source", message: "project.refusal.branchesMissing", branches }
        : { at: "field", field: "source", message: "project.refusal.sourceNotFound" };
    case "deadline_past":
      return { at: "field", field: "deadline", message: "project.refusal.deadlinePast" };
    case "duplicate_slug":
      return { at: "field", field: "name", message: "project.refusal.duplicateSlug" };
    case "distribution_failed":
      return { at: "form", message: "project.refusal.distributionFailed" };
    case "unknown_group_set":
      return { at: "field", field: "groupSet", message: "project.refusal.unknownGroupSet" };
    default:
      return null;
  }
}

/** The browser's time zone, named on the form when it is not the school's. */
export function foreignZone(): string | null {
  const zone = localTimeZone();
  return zone && zone !== SCHOOL_TIME_ZONE ? zone : null;
}
