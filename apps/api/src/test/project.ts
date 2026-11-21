/**
 * A graded project and its repositories, inserted as the release leaves
 * them, for the tests that read a project's grades (the gradebook, the
 * student's Grades page): no GitHub, no runner — the rows alone. And the
 * direct writes of a repository's grading (`project_repo_grades`) the tests
 * make beside its row.
 */
import { randomUUID } from "node:crypto";

import { eq, getTableColumns } from "drizzle-orm";

import { gradeFromPoints } from "@quiz/domain";

import type { Db } from "../db/client.js";
import { githubOrganizations, projectRepoGrades, projectRepos, projects } from "../db/schema.js";

/** A project made by {@link gradedProject}: what {@link projectRepo} needs of it. */
export interface FixtureProject {
  id: string;
  n: number;
  released: boolean;
}

let next = 90_000;
const DEADLINE = new Date("2026-10-09T22:00:00Z");
/** The release time of a `released` project. */
export const RELEASED_AT = new Date("2026-10-10T08:00:00Z");

/**
 * A locked project graded `auto` on the linear scale, in an organization of
 * its own; `released` writes {@link RELEASED_AT}, and the snapshot of every
 * repository {@link projectRepo} adds to it.
 */
export async function gradedProject(
  db: Db,
  options: { classroomId: string; name: string; createdBy: string; released: boolean; groupMode?: boolean },
): Promise<FixtureProject> {
  const n = next++;
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login: `fx-org-${n}`, githubOrgId: n, installationId: n });
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    classroomId: options.classroomId,
    orgId,
    name: options.name,
    slug: `fx-${n}`,
    state: "locked",
    startAt: new Date("2026-10-01T08:00:00Z"),
    deadlineAt: DEADLINE,
    deadlineAppliedAt: DEADLINE,
    sourceRepoId: n,
    sourceFullName: `fx-org-${n}/starter`,
    distributionRepoId: n + 1,
    distributionFullName: `fx-org-${n}/dist`,
    branches: ["main"],
    protectedFiles: [],
    gradingMode: "auto",
    gradingScale: { kind: "linear", rounding: "nearest" },
    groupMode: options.groupMode ?? false,
    createdBy: options.createdBy,
    ...(options.released ? { releasedAt: RELEASED_AT, releasedBy: options.createdBy } : {}),
  });
  return { id, n, released: options.released };
}

type GradesPatch = Partial<Omit<typeof projectRepoGrades.$inferInsert, "repoId">>;
/** A test's patch of a repository: its own columns and its grading's, which live in `project_repo_grades`. */
export type RepoPatch = Partial<typeof projectRepos.$inferInsert> & GradesPatch;

const GRADE_KEYS: ReadonlySet<string> = new Set(Object.keys(getTableColumns(projectRepoGrades)).filter((key) => key !== "repoId"));

/** `patch` split into the repository's columns and its grading's. */
export function splitRepoPatch(patch: RepoPatch): { repo: Partial<typeof projectRepos.$inferInsert>; grades: GradesPatch } {
  const entries = Object.entries(patch);
  return {
    repo: Object.fromEntries(entries.filter(([key]) => !GRADE_KEYS.has(key))),
    grades: Object.fromEntries(entries.filter(([key]) => GRADE_KEYS.has(key))),
  };
}

/** Writes `values` into a repository's grading (`project_repo_grades`), its row created when it has none: a test's direct write. */
export async function setRepoGrades(db: Db, repoId: string, values: GradesPatch): Promise<void> {
  if (Object.keys(values).length === 0) return;
  // An update first: an upsert's proposed row is checked before its conflict, and a test may patch part of an adjustment.
  const updated = await db.update(projectRepoGrades).set(values).where(eq(projectRepoGrades.repoId, repoId)).returning({ repoId: projectRepoGrades.repoId });
  if (updated.length === 0) await db.insert(projectRepoGrades).values({ ...values, repoId });
}

/** Writes `patch` into the repository's row and its grading's: a test's direct write. */
export async function patchRepo(db: Db, repoId: string, patch: RepoPatch): Promise<void> {
  const { repo, grades } = splitRepoPatch(patch);
  if (Object.keys(repo).length > 0) await db.update(projectRepos).set(repo).where(eq(projectRepos.id, repoId));
  await setRepoGrades(db, repoId, grades);
}

/** A repository's grading row as stored, undefined when it has none. */
export async function repoGradesRow(db: Db, repoId: string): Promise<typeof projectRepoGrades.$inferSelect | undefined> {
  const [row] = await db.select().from(projectRepoGrades).where(eq(projectRepoGrades.repoId, repoId));
  return row;
}

/**
 * A frozen repository of `userId` — or of the copy group `groupId`, created
 * by `userId`'s Accept — scored `points` / `max` by the teacher, with
 * `comment`; the release's snapshot too, its grade stored as
 * `releaseProject` writes it (ADR-119 §11), when the project is released.
 */
export async function projectRepo(
  db: Db,
  project: FixtureProject,
  options: { userId: string; points: number; max: number; groupId?: string; comment?: string },
): Promise<string> {
  const { userId, points, max } = options;
  const n = next++;
  const id = randomUUID();
  await db.insert(projectRepos).values({
    id,
    projectId: project.id,
    userId,
    groupId: options.groupId ?? null,
    githubRepoId: n,
    fullName: `fx-org-${project.n}/repo-${n}`,
    defaultBranch: "main",
    provisionStatus: "ok",
    acceptedAt: new Date("2026-10-01T09:00:00Z"),
    invitationStatus: "accepted",
    rulesetId: project.n,
    deadlineAppliedAt: DEADLINE,
    frozenAt: new Date("2026-10-09T22:30:00Z"),
  });
  await db.insert(projectRepoGrades).values({
    repoId: id,
    teacherPoints: points,
    teacherMax: max,
    teacherComment: options.comment ?? null,
    ...(project.released
      ? {
          releasedPoints: points,
          releasedMax: max,
          releasedGrade: gradeFromPoints(points, max, { rounding: "nearest" }),
          releasedComment: options.comment ?? null,
        }
      : {}),
  });
  return id;
}
