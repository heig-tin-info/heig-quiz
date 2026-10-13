import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { ProjectPatch, type ProjectActivitySummary } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { classroomProjectsKey } from "../queryKeys";
import { TextFieldDialog } from "../ui";
import { useRenameProject } from "./useProjectPatch";

/** What the rename dialog reads of a row. */
type Renamed = Pick<ProjectActivitySummary, "id" | "title">;

/**
 * `GET /classrooms/:id/projects` (M3-02), archived ones excepted: the
 * projects of a classroom's Activities tab (`ClassroomActivities`, M3-10).
 * A platform without the App answers 404, which the tab reads as none.
 */
export function useClassroomProjects(classroomId: string) {
  return useQuery<ProjectActivitySummary[]>({
    queryKey: classroomProjectsKey(classroomId),
    queryFn: () => api(`/app/api/classrooms/${classroomId}/projects`),
  });
}

/**
 * A project row's Rename (#804), for the classroom's Activities tab: the
 * row's button calls `rename`, and `layers` draws its dialog beside the
 * tables.
 */
export interface ProjectRowActions {
  /** Opens the rename dialog of the row. */
  rename: (row: Renamed) => void;
  /** The dialog, drawn once beside the tables. */
  layers: ReactNode;
}

export function useProjectRename(classroomId: string): ProjectRowActions {
  const [renaming, setRenaming] = useState<Renamed | null>(null);
  const layers = renaming ? (
    <RenameProjectDialog project={renaming} classroomId={classroomId} onClose={() => setRenaming(null)} />
  ) : null;
  return { rename: setRenaming, layers };
}

/**
 * "Rename" from a row (#804): the page's own rename (`useRenameProject`), so
 * the same route, schema, refresh and toasts as the name renamed in place.
 */
function RenameProjectDialog({
  project,
  classroomId,
  onClose,
}: {
  project: Renamed;
  classroomId: string;
  onClose: () => void;
}) {
  const t = useT();
  const { rename, pending } = useRenameProject(project.id, classroomId);
  return (
    <TextFieldDialog
      title={t("project.rename", { name: project.title })}
      label={t("project.name")}
      initial={project.title}
      submitLabel={t("common.rename")}
      valid={(name) => ProjectPatch.safeParse({ name }).success}
      submitting={pending}
      onSubmit={(name) => rename(name, onClose)}
      onClose={onClose}
    />
  );
}
