/**
 * What a project's deletion would erase of the students' work (ADR-141): the
 * facts `studentWorkOf` (`@quiz/domain`) judges, read under the locks of the
 * delete's transaction. A project's own delete and its classroom's or
 * course's (the `org` module) read them here.
 */
import { and, count, eq, exists, inArray, or, sql } from "drizzle-orm";

import { studentWorkOf, type ProjectWorkFacts } from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import {
  classrooms,
  projectCriterionGrades,
  projectGradeRuns,
  projectRepoGrades,
  projectRepos,
  projects,
} from "../../db/schema.js";
import { ProjectError } from "./errors.js";
import { STUDENT_REPO } from "./repos.js";

/** Where a deletion reaches projects: one, a classroom's, or a course's classrooms'. */
export type ProjectWorkScope = { projectId: string } | { classroomId: string } | { courseId: string };

/**
 * A graded repository: a row of its grading (a teacher's score, an
 * adjustment, a released snapshot), a validated criterion, or a counted run
 * of the CI. A proposal the teacher never validated is not a grade.
 */
const GRADED_REPO = or(
  exists(sql`(SELECT 1 FROM ${projectRepoGrades} WHERE ${projectRepoGrades.repoId} = ${projectRepos.id})`),
  exists(
    sql`(SELECT 1 FROM ${projectCriterionGrades} WHERE ${projectCriterionGrades.repoId} = ${projectRepos.id} AND ${projectCriterionGrades.state} = 'validated')`,
  ),
  exists(sql`(SELECT 1 FROM ${projectGradeRuns} WHERE ${projectGradeRuns.repoId} = ${projectRepos.id})`),
)!;

/**
 * The facts of the projects of `scope`. Their rows, then their repositories'
 * rows, are locked `FOR UPDATE` first: inside a delete's transaction a
 * release, a new repository and a new grade, run or validation (each takes
 * `FOR KEY SHARE` on its repository through its foreign key, or updates the
 * project) wait for the delete, and then find it gone. Outside one, a plain
 * read.
 */
export async function projectWork(db: Db | Tx, scope: ProjectWorkScope): Promise<ProjectWorkFacts[]> {
  const where =
    "projectId" in scope
      ? eq(projects.id, scope.projectId)
      : "classroomId" in scope
        ? eq(projects.classroomId, scope.classroomId)
        : inArray(
            projects.classroomId,
            db.select({ id: classrooms.id }).from(classrooms).where(eq(classrooms.courseId, scope.courseId)),
          );
  const rows = await db
    .select({ id: projects.id, classroomId: projects.classroomId, releasedAt: projects.releasedAt })
    .from(projects)
    .where(where)
    .for("update");
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  await db.select({ id: projectRepos.id }).from(projectRepos).where(inArray(projectRepos.projectId, ids)).for("update");
  const graded = await db
    .select({ id: projectRepos.projectId, n: count() })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .where(and(inArray(projectRepos.projectId, ids), STUDENT_REPO, GRADED_REPO))
    .groupBy(projectRepos.projectId);
  const gradedOf = new Map(graded.map((g) => [g.id, g.n]));
  return rows.map((r) => ({ classroomId: r.classroomId, released: r.releasedAt !== null, gradedRepos: gradedOf.get(r.id) ?? 0 }));
}

/** ADR-141: the refusal of deleting a project that holds students' work, or null. */
export async function projectStudentWorkRefusal(db: Db | Tx, projectId: string): Promise<ProjectError | null> {
  const work = studentWorkOf({ evaluations: [], projects: await projectWork(db, { projectId }) });
  return work && new ProjectError("holds_student_work", "The project holds students' grades: archive it instead (ADR-141)", { work });
}
