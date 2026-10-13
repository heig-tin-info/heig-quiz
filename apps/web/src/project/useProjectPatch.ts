import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ProjectPatch, type ProjectSummary } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { activitiesKey, classroomGroupSetsKey, classroomProjectsKey, projectKey } from "../queryKeys";
import { refusalMessage } from "./projectPage";

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

/**
 * Renaming a project, wherever it starts: its name in place (`ProjectPage`)
 * or "Rename" on its row of the classroom's list (`ClassroomActivities`). The
 * page's writer, the name checked by the route's schema first, "Saved" or
 * the refusal in words. A name changes in every state
 * (`projectFieldRefusal`); the slug, and so the repositories, never do.
 * `onDone` runs once the write and the refresh landed.
 */
export function useRenameProject(id: string, classroomId: string | null) {
  const t = useT();
  const toast = useToast();
  const patch = useProjectPatch(id, classroomId);
  const rename = (name: string, onDone?: () => void) => {
    const parsed = ProjectPatch.safeParse({ name });
    if (!parsed.success) return;
    patch.mutate(parsed.data, {
      onSuccess: () => {
        toast(t("sync.saved"), "success");
        onDone?.();
      },
      onError: (error) => toast(refusalMessage(error, t), "error"),
    });
  };
  /** The name a save in flight carries, for `EditableTitle`'s `pending`. */
  const pendingName = patch.isPending ? patch.variables?.name : undefined;
  return { rename, pending: patch.isPending, pendingName };
}
