/**
 * The `project` module (F-PROJ, ADR-035, spec 05 §5.11,
 * docs/merge/03-github-projects.md §3.3): the entry other modules import.
 * It owns the tables of `db/project.ts`; it reads the `github` module's
 * organizations and links by join and purges push receipts through its
 * service (`purgeProjectReceipts`), never writing them itself.
 *
 * From M3-02: the lifecycle (`lifecycle.ts`), the staff's views
 * (`views.ts`), the organization's repository browser (`sources.ts`).
 * From M3-03: a student's Accept and its provisioning (`accept.ts`).
 * From M3-04: GitHub's events on projects (`webhooks.ts`, registered by
 * the plugin), the grading pipeline (`grading.ts`, `ingestCompletedRun`,
 * the one path M3-06 reuses), the protected files (`protection.ts`).
 */
export { acceptProject } from "./accept.js";
export {
  createProject,
  deleteProject,
  patchProject,
  publishProject,
  setProjectArchived,
  unassignedStudents,
  type CreateInput,
  type Unassigned,
} from "./lifecycle.js";
export { ProjectError } from "./errors.js";
export { listSources, sourceDetail } from "./sources.js";
export { classroomProjects, projectSummary, teacherProjects, type ProjectRow } from "./views.js";
