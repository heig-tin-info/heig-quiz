import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ProjectPatch, ProjectSummary } from "@quiz/contracts";

import { api } from "../api";
import { activitiesKey, classroomGroupSetsKey, classroomProjectsKey, projectKey } from "../queryKeys";

/** What a write to a project changed besides its page: the classroom's lists and the Activities. */
export function useProjectRefresh(id: string, classroomId: string | null) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: projectKey(id) }),
      classroomId ? qc.invalidateQueries({ queryKey: classroomProjectsKey(classroomId) }) : null,
      // A set named, or another one, changes what the sets say they are used by.
      classroomId ? qc.invalidateQueries({ queryKey: classroomGroupSetsKey(classroomId) }) : null,
      qc.invalidateQueries({ queryKey: activitiesKey }),
    ]);
}

/**
 * The one writer of a project's settings (`PATCH /projects/:id`), wherever
 * the write starts: its page (the name in place, the draft form, the group
 * set) or a row's "Rename" in the classroom's projects list. `onPatched`
 * runs before the refresh, with the body sent, for what the caller keeps
 * beside the cache.
 */
export function useProjectPatch(
  id: string,
  classroomId: string | null,
  onPatched?: (body: ProjectPatch) => void,
) {
  const refresh = useProjectRefresh(id, classroomId);
  return useMutation({
    mutationFn: (body: ProjectPatch) =>
      api<ProjectSummary>(`/app/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: async (_, body) => {
      onPatched?.(body);
      await refresh();
    },
  });
}
