/**
 * The project kind of activity (F-PROJ, ADR-035 §2). Lists nothing yet: the
 * union and the tables exist (M3-01), the `project` module that reads them
 * comes with M3-02, which fills these methods — staff summaries through its
 * own access predicate (`staffAccess` on the classroom's course), student
 * cards through the caller's claimed seat — and may move this adapter next
 * to its service, as `evaluation.ts` is to the evaluation module's.
 */
import type { ActivityKind } from "./kind.js";

export const projectActivity: ActivityKind<"project"> = {
  kind: "project",
  listForTeacher: async () => [],
  studentCards: async () => ({ polls: [], open: [], upcoming: [], past: [] }),
};
