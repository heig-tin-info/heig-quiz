/**
 * The evaluations' rows of a student's Grades (`GET /student/results`),
 * every classroom flattened: the tests of the evaluations read these, the
 * projects' rows being another kind (M3-08).
 */
import type { StudentGrades } from "@quiz/contracts";

export const evaluationRows = (groups: StudentGrades) =>
  groups.flatMap((g) => g.rows).filter((r) => r.kind === "evaluation");
