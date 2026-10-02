/**
 * The project kind of activity (F-PROJ, ADR-035 §2). An adapter, like
 * `evaluation.ts`: each method is what the `project` module answers.
 *
 * - `listForTeacher` (M3-02): the projects of every classroom the caller
 *   holds a staff seat on, drafts included, archived ones and archived
 *   classrooms left out — `staffAccess` in the WHERE (invariant 6).
 * - `studentCards` stays EMPTY until M3-09 brings the project's student
 *   view, its one exit (N-SEC-20), and the leak test that goes with it:
 *   teachers may create projects before the cutover (D26 addendum,
 *   2026-10-02), the students see none of them until then.
 */
import { teacherProjects } from "../project/service.js";
import type { ActivityKind } from "./kind.js";

export const projectActivity: ActivityKind<"project"> = {
  kind: "project",
  listForTeacher: (db, caller) => teacherProjects(db, caller),
  studentCards: async () => ({ polls: [], open: [], upcoming: [], past: [] }),
};
