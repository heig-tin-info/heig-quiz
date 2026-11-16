/*
 * The reads and writes of the gradebook (F-GBOOK, ADR-074, M5-04), on the
 * routes of `apps/api/src/modules/gradebook/routes.ts`. Every write answers
 * the staff's table as it now stands (`GradebookStaff`), which replaces the
 * cache: no optimistic move, the server's table is the only one. A body is
 * built by the route's own schema (invariant 7).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  GradebookColumnPatch,
  GradebookComponentCreate,
  GradebookComponentPatch,
  GradebookMarkPut,
  GradebookSettingsPatch,
  GradebookTemplateColumnPatch,
  type GradebookColumn,
  type GradebookColumnSettings,
  type GradebookComponents,
  type GradebookErrorCode,
  type GradebookStaff,
  type GradebookStudent,
} from "@quiz/contracts";

import { api, wordedRefusal } from "../api";
import type { Dict, TFunction } from "../i18n";
import { classroomGradebookKey, columnSettingsKey, courseComponentsKey, gradebookRootKey, studentGradebookKey } from "../queryKeys";

/** `GET /classrooms/:id/gradebook`: the staff's table. */
export function useStaffGradebook(classroomId: string) {
  return useQuery<GradebookStaff>({
    queryKey: classroomGradebookKey(classroomId),
    queryFn: () => api(`/app/api/classrooms/${classroomId}/gradebook`),
  });
}

/** `GET /student/classrooms/:id/gradebook`: the caller's own cells, narrowed by the server. */
export function useStudentGradebook(classroomId: string) {
  return useQuery<GradebookStudent>({
    queryKey: studentGradebookKey(classroomId),
    queryFn: () => api(`/app/api/student/classrooms/${classroomId}/gradebook`),
  });
}

/**
 * Where a column's settings live (ADR-131 §13, §15): an activity of a
 * classroom, a draft's included, or an evaluation template of a course,
 * whose settings its instances start with.
 */
export type ColumnHome = ({ classroomId: string } & ColumnRef) | { templateId: string };

/** The read and the write of a column's settings: `…/gradebook/columns/:kind/:activityId`, or `/templates/:id/gradebook`. */
const settingsPath = (home: ColumnHome) =>
  "templateId" in home
    ? `/app/api/templates/${home.templateId}/gradebook`
    : `/app/api/classrooms/${home.classroomId}/gradebook${columnPath(home)}`;

/**
 * One column's settings as a settings screen edits them, from the draft on,
 * with the course's components and whether a change moves what the students
 * read (never, for a template: `released` is false). Under the gradebook's
 * root: its hint refreshes it.
 */
export function useColumnSettings(home: ColumnHome) {
  return useQuery<GradebookColumnSettings>({
    queryKey: columnSettingsKey(home),
    queryFn: () => api(settingsPath(home)),
  });
}

/** Reads a column's settings again: after a change of mode, whose defaults a column nobody set reads (ADR-131 §13, §15). */
export function useColumnSettingsRefresh(home: ColumnHome) {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: columnSettingsKey(home) });
}

/**
 * A template's column write (`PATCH /templates/:id/gradebook`, ADR-131
 * §15): the narrow patch, no position; it answers the settings, which
 * replace the cache. An activity's goes through `useGradebookWrites`.
 */
export function useTemplateColumnWrite(templateId: string) {
  const qc = useQueryClient();
  const home = { templateId };
  const send = useMutation({
    mutationFn: (patch: GradebookTemplateColumnPatch) =>
      api<GradebookColumnSettings>(settingsPath(home), {
        method: "PATCH",
        body: JSON.stringify(GradebookTemplateColumnPatch.parse(patch)),
      }),
    onSuccess: (settings) => qc.setQueryData(columnSettingsKey(home), settings),
  });
  return { pending: send.isPending, patch: send.mutateAsync };
}

/** The CSV of the table (F-GBOOK-04): a plain download link, like the results'. */
export const gradebookCsvPath = (classroomId: string) => `/app/api/classrooms/${classroomId}/gradebook.csv`;

/** A column's address in the routes: its activity. */
export type ColumnRef = Pick<GradebookColumn, "kind" | "activityId">;

const columnPath = (column: ColumnRef) => `/columns/${column.kind}/${column.activityId}`;

/** The words of each refusal of the gradebook routes, by code. */
const REFUSAL_KEY: Record<GradebookErrorCode, keyof Dict> = {
  classroom_archived: "gbook.refusal.archived",
  grade_exists: "gbook.refusal.gradeExists",
  score_above_max: "gbook.refusal.aboveMax",
  owner_required: "gbook.refusal.ownerRequired",
  component_name_taken: "gbook.refusal.componentNameTaken",
  component_in_use: "gbook.refusal.componentInUse",
};

/** What a failed write says, always in the reader's language; the server's message is English. */
export const gradebookRefusalMessage = (error: unknown, t: TFunction): string => wordedRefusal(error, REFUSAL_KEY, t);

/**
 * The staff's writes of one classroom's gradebook. Each one resolves with the
 * table it answered (already in the cache) and rejects with the `ApiError`:
 * what to say, and whether a `409 grade_exists` asks for a confirmation, is
 * the caller's.
 */
export function useGradebookWrites(classroomId: string) {
  const qc = useQueryClient();
  const base = `/app/api/classrooms/${classroomId}/gradebook`;
  const send = useMutation({
    mutationFn: ({ path, method, body }: { path: string; method: "PUT" | "PATCH" | "DELETE"; body?: unknown }) =>
      api<GradebookStaff>(`${base}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    onSuccess: (table) => qc.setQueryData(classroomGradebookKey(classroomId), table),
  });
  const run = (path: string, method: "PUT" | "PATCH" | "DELETE", body?: unknown) =>
    send.mutateAsync({ path, method, body });
  return {
    pending: send.isPending,
    setMark: (column: ColumnRef, enrollmentId: string, mark: GradebookMarkPut) =>
      run(`${columnPath(column)}/marks/${enrollmentId}`, "PUT", GradebookMarkPut.parse(mark)),
    clearMark: (column: ColumnRef, enrollmentId: string) => run(`${columnPath(column)}/marks/${enrollmentId}`, "DELETE"),
    /** The table answered lists no draft: the column's own read is asked again (`useColumnSettings`). */
    patchColumn: async (column: ColumnRef, patch: GradebookColumnPatch) => {
      const table = await run(columnPath(column), "PATCH", GradebookColumnPatch.parse(patch));
      await qc.invalidateQueries({ queryKey: columnSettingsKey({ classroomId, ...column }) });
      return table;
    },
    publishMean: (meanPublished: boolean) =>
      run("", "PATCH", GradebookSettingsPatch.parse({ meanPublished })),
  };
}

/** `GET /courses/:id/gradebook/components`: the course's components of the mean, in creation order (ADR-131). */
export function useCourseComponents(courseId: string) {
  return useQuery<GradebookComponents>({
    queryKey: courseComponentsKey(courseId),
    queryFn: () => api(`/app/api/courses/${courseId}/gradebook/components`),
  });
}

/**
 * The owner's writes of a course's components. Every gradebook of the course
 * may have moved with them (a weight, a component gone), so everything under
 * the gradebook's root is read again, the list included.
 */
export function useComponentWrites(courseId: string) {
  const qc = useQueryClient();
  const base = `/app/api/courses/${courseId}/gradebook/components`;
  const send = useMutation({
    mutationFn: ({ path, method, body }: { path: string; method: "POST" | "PATCH" | "DELETE"; body?: unknown }) =>
      api<GradebookComponents>(`${base}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: gradebookRootKey }),
  });
  return {
    pending: send.isPending,
    create: (body: GradebookComponentCreate) => send.mutateAsync({ path: "", method: "POST", body: GradebookComponentCreate.parse(body) }),
    patch: (id: string, body: GradebookComponentPatch) =>
      send.mutateAsync({ path: `/${id}`, method: "PATCH", body: GradebookComponentPatch.parse(body) }),
    remove: (id: string) => send.mutateAsync({ path: `/${id}`, method: "DELETE" }),
  };
}
