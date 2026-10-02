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
  type ProjectSourceDetail,
} from "@quiz/contracts";
import type { ProjectScaleKind } from "@quiz/domain";

import { ApiError } from "../api";
import { fromLocalInput } from "../evaluation/timing";
import type { Dict } from "../i18n";

/** What the teacher fills in. Strings where an input holds one: the form keeps what was typed. */
export interface ProjectDraft {
  name: string;
  sourceRepo: string;
  /** In the order chosen, the first the students' default; null: the source's default branch. */
  branches: string[] | null;
  publishMode: "manual" | "scheduled";
  /** A manual publication's deadline: a date, or a duration counted from the publication. */
  deadlineKind: "date" | "duration";
  /** `datetime-local` values, in the browser's zone. */
  startLocal: string;
  deadlineLocal: string;
  durationDays: string;
  durationHours: string;
  graceMinutes: string;
  sourceStrategy: "squash" | "whole";
  deadlineStrategy: "lock" | "commit";
  gradingMode: "auto" | "none";
  scaleKind: ProjectScaleKind;
  /** null: the source's suggestions (`suggestedProtected`), the default even while Advanced stays folded. */
  protectedFiles: string[] | null;
  groupMode: boolean;
  groupMaxSize: string;
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
  durationHours: "",
  graceMinutes: String(PROJECT_DEFAULTS.graceMinutes),
  sourceStrategy: PROJECT_DEFAULTS.sourceStrategy,
  deadlineStrategy: PROJECT_DEFAULTS.deadlineStrategy,
  gradingMode: PROJECT_DEFAULTS.gradingMode,
  scaleKind: "linear",
  protectedFiles: null,
  groupMode: false,
  groupMaxSize: "",
});

/** The fields a message can stand under. */
export type ProjectField = "name" | "source" | "start" | "deadline" | "duration" | "grace" | "groupMaxSize";

/** The branches handed out: the ones chosen that the source still has, else its default branch. */
export function chosenBranches(draft: ProjectDraft, detail: ProjectSourceDetail): string[] {
  const kept = (draft.branches ?? []).filter((b) => detail.branches.includes(b));
  return kept.length > 0 ? kept : [detail.defaultBranch];
}

/** The protected files sent: those chosen, or the source's suggestions. */
export const chosenProtected = (draft: ProjectDraft, detail: ProjectSourceDetail): string[] =>
  draft.protectedFiles ?? [...detail.suggestedProtected];

/** The grading workflow the source holds, which unchecking warns about (F-PROJ-01). */
export const GRADING_WORKFLOW = ".github/workflows/grading.yml";

/** The source holds `grading.yml` and the teacher unchecked it: the student could alter the grading. */
export const gradingUnprotected = (draft: ProjectDraft, detail: ProjectSourceDetail): boolean =>
  detail.suggestedProtected.includes(GRADING_WORKFLOW) && !chosenProtected(draft, detail).includes(GRADING_WORKFLOW);

/** A count typed in a field: an integer, or undefined when it is empty or not one. */
function count(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

/** The duration in minutes, undefined while neither field holds a count. */
export function durationMinutes(draft: ProjectDraft): number | undefined {
  const days = count(draft.durationDays);
  const hours = count(draft.durationHours);
  if (days === undefined && hours === undefined) return undefined;
  if ((draft.durationDays.trim() !== "" && days === undefined) || (draft.durationHours.trim() !== "" && hours === undefined)) {
    return undefined;
  }
  return ((days ?? 0) * 24 + (hours ?? 0)) * 60;
}

/** The body before the schema, every empty or unreadable value left out (the schema then names it). */
function rawBody(draft: ProjectDraft, detail: ProjectSourceDetail | undefined): Record<string, unknown> {
  const manualDuration = draft.publishMode === "manual" && draft.deadlineKind === "duration";
  const grace = count(draft.graceMinutes);
  const maxSize = count(draft.groupMaxSize);
  return {
    name: draft.name,
    sourceRepo: draft.sourceRepo,
    ...(detail ? { branches: chosenBranches(draft, detail), protectedFiles: chosenProtected(draft, detail) } : {}),
    publishMode: draft.publishMode,
    ...(draft.publishMode === "scheduled" ? { startAt: fromLocalInput(draft.startLocal) ?? undefined } : {}),
    ...(manualDuration
      ? { durationMinutes: durationMinutes(draft) ?? Number.NaN }
      : { deadlineAt: fromLocalInput(draft.deadlineLocal) ?? undefined }),
    graceMinutes: grace ?? Number.NaN,
    sourceStrategy: draft.sourceStrategy,
    deadlineStrategy: draft.deadlineStrategy,
    gradingMode: draft.gradingMode,
    gradingScale: { kind: draft.scaleKind },
    groupMode: draft.groupMode,
    ...(draft.groupMode && draft.groupMaxSize.trim() !== "" ? { groupMaxSize: maxSize ?? Number.NaN } : {}),
  };
}

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
  groupMaxSize: "groupMaxSize",
};

/** What a field says when the schema refuses it, in the teacher's words. */
function fieldMessage(field: ProjectField, draft: ProjectDraft): keyof Dict {
  switch (field) {
    case "name":
      return draft.name.trim() === "" ? "project.missing.name" : "project.missing.nameSlug";
    case "deadline":
      return fromLocalInput(draft.deadlineLocal) === null ? "project.missing.deadline" : "project.missing.deadlineOrder";
    default:
      return `project.missing.${field}`;
  }
}

/**
 * The body `POST …/projects` takes, or the fields still to fix. The source's
 * detail is needed: it carries the branches and the protected files sent by
 * default; until it is read, the source field says so.
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
  if (draft.publishMode === "scheduled" || draft.deadlineKind === "date") {
    if (fromLocalInput(draft.deadlineLocal) === null) missing.deadline = "project.missing.deadline";
  } else if (durationMinutes(draft) === undefined) {
    missing.duration = "project.missing.duration";
  }
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = FIELD_OF[String(issue.path[0])];
      if (field && !missing[field]) missing[field] = fieldMessage(field, draft);
    }
  }
  if (draft.sourceRepo !== "" && !detail && !missing.source) missing.source = "project.source.detailFailed";
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
    default:
      return null;
  }
}

/** The browser's time zone, named on the form when it is not the school's. */
export function foreignZone(): string | null {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && zone !== "Europe/Zurich" ? zone : null;
}
