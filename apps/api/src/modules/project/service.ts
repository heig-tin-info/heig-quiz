/**
 * The `project` module (F-PROJ, ADR-035, spec 05 §5.11,
 * docs/merge/03-github-projects.md §3.3): the entry other modules import.
 * It owns the tables of `db/project.ts`; it reads the `github` module's
 * organizations and links by join and purges push receipts through its
 * service (`purgeProjectReceipts`), never writing them itself.
 *
 * From M3-02: the lifecycle (`lifecycle.ts`), the staff's views
 * (`views.ts`), the organization's repository browser (`sources.ts`).
 */
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
