/**
 * A graded project and its repositories, inserted as the release leaves
 * them, for the tests that read a project's grades (the gradebook, the
 * student's Grades page): no GitHub, no runner — the rows alone.
 */
import { randomUUID } from "node:crypto";

import { gradeFromPoints } from "@quiz/domain";

import type { Db } from "../db/client.js";
import { githubOrganizations, projectRepos, projects } from "../db/schema.js";

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
): Promise<void> {
  const { userId, points, max } = options;
  const n = next++;
  await db.insert(projectRepos).values({
    id: randomUUID(),
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
}
