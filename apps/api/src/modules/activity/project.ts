/**
 * The project kind of activity (F-PROJ, ADR-035 §2). An adapter, like
 * `evaluation.ts`: each method is what the `project` module answers.
 *
 * - `listForTeacher` (M3-02): the projects of every classroom the caller
 *   holds a staff seat on, drafts included, archived ones and archived
 *   classrooms left out — `staffAccess` in the WHERE (invariant 6).
 * - `studentCards` (M3-09a): the published projects of the classrooms where
 *   the caller holds a claimed seat, through the project's student view
 *   (`studentProjectCards`), its one exit (N-SEC-20) — never a draft, never
 *   an archived project, nothing of another student.
 */
import { studentProjectCards, teacherProjects } from "../project/service.js";
import type { ActivityKind } from "./kind.js";

export const projectActivity: ActivityKind<"project"> = {
  kind: "project",
  listForTeacher: (db, caller) => teacherProjects(db, caller),
  studentCards: async (db, caller, now, classroomId) => ({
    polls: [],
    ...(await studentProjectCards(db, caller.id, now, classroomId)),
  }),
};
