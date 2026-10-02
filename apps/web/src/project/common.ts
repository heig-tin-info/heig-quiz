/*
 * What every project surface agrees on (M3-10): the badge of a state, and the
 * classroom's read of its projects. The classroom's Projects group and the
 * Activities section show the same badge; the project page (M3-12) will too.
 */
import { useQuery } from "@tanstack/react-query";

import type { ProjectActivitySummary, ProjectState } from "@quiz/contracts";

import { api } from "../api";
import type { TFunction } from "../i18n";
import { classroomProjectsKey } from "../queryKeys";
import type { Tone } from "../ui";

/**
 * Green while the students work in it, zinc at rest — a draft nobody sees
 * yet, a project locked at its deadline. Never the accent, as for an
 * evaluation's state (`evaluation/common.ts`).
 */
const STATE_TONE: Record<ProjectState, Tone> = {
  draft: "zinc",
  published: "green",
  locked: "zinc",
};

export const projectStateTone = (state: ProjectState): Tone => STATE_TONE[state];

export const projectStateLabel = (state: ProjectState, t: TFunction): string => t(`project.state.${state}`);

/**
 * `GET /classrooms/:id/projects` (M3-02): the classroom's projects, archived
 * ones excepted. A 404 is a platform without projects (no GitHub App): the
 * caller then draws none (`githubAbsent`).
 */
export function useClassroomProjects(classroomId: string) {
  return useQuery<ProjectActivitySummary[]>({
    queryKey: classroomProjectsKey(classroomId),
    queryFn: () => api(`/app/api/classrooms/${classroomId}/projects`),
  });
}
