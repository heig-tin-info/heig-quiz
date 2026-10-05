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
  GradebookMarkPut,
  GradebookSettingsPatch,
  type GradebookColumn,
  type GradebookErrorCode,
  type GradebookStaff,
  type GradebookStudent,
} from "@quiz/contracts";

import { api, wordedRefusal } from "../api";
import type { Dict, TFunction } from "../i18n";
import { classroomGradebookKey, studentGradebookKey } from "../queryKeys";

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
    patchColumn: (column: ColumnRef, patch: GradebookColumnPatch) =>
      run(columnPath(column), "PATCH", GradebookColumnPatch.parse(patch)),
    publishMean: (meanPublished: boolean) =>
      run("", "PATCH", GradebookSettingsPatch.parse({ meanPublished })),
  };
}
