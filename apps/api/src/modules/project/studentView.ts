/**
 * The project's student view (F-PROJ-04, F-PROJ-07, F-PROJ-15; merge task
 * M3-09a): THE one exit of a project towards a student (N-SEC-20, spec 05
 * §5.7), like `toStudent` for a question and the journal's student view.
 * Everything a student reads of a project — their cards on the home and
 * the classroom page, their project's page, their own resend of an
 * invitation — is built here and nowhere else; nothing of `detail.ts` (the
 * staff's page) is reused nor filtered.
 *
 * What it carries: the project's facts (name, start, the student's
 * EFFECTIVE deadline, state), the caller's OWN repository — its name and
 * URL, their invitation, the commit the view stands on and its CI status,
 * the run their score comes from and that score, indicative until the
 * release (`studentScoreRun` of `@quiz/domain`: the current CI score, the
 * frozen one once their deadline is applied) — and, once released, the
 * final score's snapshot, its grade and the teacher's comment as the
 * release wrote it.
 *
 * What it never carries: the source or distribution repository (not even
 * their existence), another student's repository or score, a push or a run
 * after the deadline (once the deadline is applied or passed, the commit
 * and the CI state shown are the SELECTED run's, not the row's, which the
 * webhooks keep moving on an open repository), the review's or the
 * teacher's score before the release, the staff's flags (`to_verify`,
 * `multiple`, `malformed`, the suspended protection), a draft or an
 * archived project. The leak test of `studentView.db.test.ts` searches
 * every student response for them.
 *
 * The repository is the seat's: read through a STUDENT seat only — a staff
 * seat (a teacher in the student view, ADR-018) holds none, so the view
 * shows them the project without a repository and Accept stays refused to
 * them (`studentProject`, `guards.ts`). In a group project it is the seat's
 * copy group's (`seatRepo`, `groupRepos.ts`), never the repository its
 * creator moved out of (N-SEC-20, M3-15b).
 */
import { and, eq, isNull, ne, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyBaseLogger } from "fastify";

import type {
  ProjectInvitationResent,
  StudentProject,
  StudentProjectCard,
  StudentProjectRepo,
  StudentProjectScore,
} from "@quiz/contracts";
import {
  effectiveDeadline,
  pickStudentRepo,
  scoreGrade,
  studentCiReading,
  studentProjectGroup,
  studentProjectStatus,
  studentScoreRun,
  type StudentActivityGroup,
} from "@quiz/domain";

import type { AuditActor } from "../../audit.js";
import { iso, isoOrNull } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { classrooms, courses, enrollments, githubAccounts, projectGradeRuns, projectGroupMembers, projectRepos, projects } from "../../db/schema.js";
import { htmlUrl } from "../../github/git.js";
import type { StudentProjectScope } from "../guards.js";
import { EFFECTIVE_DEADLINE, isLive } from "./deadline.js";
import { slotRuns } from "./detail.js";
import { ProjectError } from "./errors.js";
import { seatRepo } from "./groupRepos.js";
import { resendInvitation } from "./invitation.js";
import type { RepoRow } from "./repos.js";
import type { ProjectRow } from "./views.js";

type RunRow = typeof projectGradeRuns.$inferSelect;
/** A row whose repository exists on GitHub's side: provisioned, named. */
type ProvisionedRepo = RepoRow & { fullName: string };

const runUrl = (fullName: string, workflowRunId: number): string => `${htmlUrl(fullName)}/actions/runs/${workflowRunId}`;

/** The student's repository, once Accept provisioned it; a pending or failed row is not one yet. */
const provisioned = (repo: RepoRow | null): ProvisionedRepo | null =>
  repo !== null && repo.provisionStatus === "ok" && repo.fullName !== null ? (repo as ProvisionedRepo) : null;

/** Whether `userId` linked a GitHub account (F-GH-05): the card leads to linking it otherwise. */
async function githubLinked(db: Db, userId: string): Promise<boolean> {
  const [row] = await db.select({ id: githubAccounts.userId }).from(githubAccounts).where(eq(githubAccounts.userId, userId)).limit(1);
  return row !== undefined;
}

interface CardRow {
  project: ProjectRow;
  classroomName: string;
  courseCode: string;
  /** The student's row (their own, or their group's), through a student seat; null without one. */
  repo: RepoRow | null;
}

/** The card's facts, without the repository's three fields: what the card and the view share. */
type CardFacts = Omit<StudentProjectCard, "invitation" | "repoFullName" | "repoUrl">;

/** The facts of `row` at `now`, judged by `@quiz/domain`, and the group of the Activities they fall in. */
function cardFacts(row: CardRow, linked: boolean, now: Date): { facts: CardFacts; group: StudentActivityGroup } {
  const judged = {
    startAt: row.project.startAt,
    deadlineAt: effectiveDeadline(row.repo ?? { deadlineAt: null }, row.project),
    released: row.project.releasedAt !== null,
    accepted: provisioned(row.repo) !== null,
    locked: row.repo?.lockedAt != null,
  };
  return {
    group: studentProjectGroup(judged, now),
    facts: {
      kind: "project",
      id: row.project.id,
      title: row.project.name,
      classroomId: row.project.classroomId,
      classroomName: row.classroomName,
      courseCode: row.courseCode,
      startAt: iso(judged.startAt),
      deadlineAt: iso(judged.deadlineAt),
      status: studentProjectStatus(judged, now),
      githubLinked: linked,
    },
  };
}

/** One card (F-PROJ-04): the facts, and the repository's name and URL once it exists and is not deleted. */
function card(row: CardRow, linked: boolean, now: Date): { card: StudentProjectCard; group: StudentActivityGroup } {
  const { facts, group } = cardFacts(row, linked, now);
  const repo = provisioned(row.repo);
  const live = repo !== null && isLive(repo, row.project) ? repo : null;
  return {
    group,
    card: {
      ...facts,
      invitation: live === null || live.invitationStatus === "none" ? null : live.invitationStatus,
      repoFullName: live?.fullName ?? null,
      repoUrl: live === null ? null : htmlUrl(live.fullName),
    },
  };
}

/** The student's cards (`projectActivity.studentCards`), grouped as the Activities list them. */
export type StudentProjectCards = Record<StudentActivityGroup, StudentProjectCard[]>;

/**
 * The published projects (locked ones included) of the classrooms where
 * `userId` holds a claimed seat — one classroom when `classroomId` is given
 * (the classroom page, loaded through `readableClassroom` by the route),
 * all of them otherwise (the home) — with the caller's own repository where
 * their seat is a student's. Never a draft, never an archived project
 * (F-PROJ-04, F-PROJ-16); the soonest EFFECTIVE deadline first, then by
 * name.
 */
export async function studentProjectCards(db: Db, userId: string, now: Date, classroomId?: string): Promise<StudentProjectCards> {
  const scope: (SQL | undefined)[] = [
    eq(enrollments.userId, userId),
    classroomId === undefined ? undefined : eq(enrollments.classroomId, classroomId),
  ];
  const groupRepos = alias(projectRepos, "group_repo");
  const rows = await db
    .select({ project: projects, classroomName: classrooms.name, courseCode: courses.code, own: projectRepos, group: groupRepos })
    .from(enrollments)
    .innerJoin(classrooms, eq(enrollments.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .innerJoin(projects, and(eq(projects.classroomId, classrooms.id), ne(projects.state, "draft"), isNull(projects.archivedAt)))
    .leftJoin(
      projectRepos,
      and(
        eq(projectRepos.projectId, projects.id),
        eq(projectRepos.userId, userId),
        isNull(projectRepos.groupId),
        // A staff seat never holds a student's repository (ADR-018).
        eq(enrollments.staff, false),
      ),
    )
    // A group project's repository: the seat's copy group's (N-SEC-20).
    .leftJoin(
      projectGroupMembers,
      and(
        eq(projectGroupMembers.projectId, projects.id),
        eq(projectGroupMembers.enrollmentId, enrollments.id),
        eq(projects.groupMode, true),
        eq(enrollments.staff, false),
      ),
    )
    .leftJoin(groupRepos, and(eq(groupRepos.projectId, projects.id), eq(groupRepos.groupId, projectGroupMembers.groupId)))
    .where(and(...scope))
    .orderBy(EFFECTIVE_DEADLINE, projects.name);
  const linked = rows.length > 0 && (await githubLinked(db, userId));
  const groups: StudentProjectCards = { open: [], upcoming: [], past: [] };
  for (const { own, group, ...row } of rows) {
    const repo = row.project.groupMode ? pickStudentRepo(own ?? undefined, group ?? undefined) : own;
    const placed = card({ ...row, repo: repo ?? null }, linked, now);
    groups[placed.group].push(placed.card);
  }
  return groups;
}

/** What the view shows of a repository's commits and runs: the commit it stands on, its CI state, the selected run and its score. */
type RepoReading = Pick<StudentProjectRepo, "lastCommit" | "ciStatus" | "run" | "score">;

/**
 * The repository as the student reads it (F-PROJ-15, N-SEC-20): the run
 * and the commit by `studentScoreRun` and `studentCiReading` of
 * `@quiz/domain` — the stored head before the deadline, the SELECTED run
 * alone once it is over — and the run's score, indicative; no score under
 * grading `none`.
 */
function reading(project: ProjectRow, repo: ProvisionedRepo, runs: Map<string, RunRow>, now: Date): RepoReading {
  const slot = (id: string | null) => (id === null ? null : (runs.get(id) ?? null));
  const chosen = studentScoreRun({
    deadlineAppliedAt: repo.deadlineAppliedAt,
    current: slot(repo.currentGradeRunId),
    frozen: slot(repo.frozenGradeRunId),
  });
  const ci = studentCiReading(repo, chosen?.run ?? null, effectiveDeadline(repo, project), now);
  const stored: Pick<RepoReading, "lastCommit" | "ciStatus"> = {
    lastCommit: ci.lastCommit === null ? null : { sha: ci.lastCommit.sha, at: isoOrNull(ci.lastCommit.at) },
    ciStatus: ci.ciStatus,
  };
  if (chosen === null) return { ...stored, run: null, score: null };
  const { run, frozen } = chosen;
  const score: StudentProjectScore | null =
    project.gradingMode === "auto" && run.parseStatus === "ok" && run.points !== null
      ? { points: run.points, max: run.max, grade: scoreGrade(run.points, run.max, project.gradingScale), frozen }
      : null;
  return {
    ...stored,
    run: { sha: run.headSha, url: runUrl(repo.fullName, run.workflowRunId), conclusion: run.conclusion, completedAt: iso(run.completedAt) },
    score,
  };
}

/**
 * `GET /app/api/student/projects/:id` (F-PROJ-15): the student payload of
 * the project `scope` loaded through `studentProjectView` (invariant 6),
 * for `userId` — the caller, or the impersonated student (ADR-034). A
 * repository deleted on GitHub is still theirs to read, said `deleted`,
 * with nothing of its runs.
 */
export async function studentProject(db: Db, scope: StudentProjectScope, userId: string, now: Date): Promise<StudentProject> {
  const { project } = scope;
  const row = scope.seat !== null && !scope.seat.staff ? await seatRepo(db, project, { enrollmentId: scope.seat.id, userId }) : null;
  const repo = provisioned(row);
  const live = repo !== null && isLive(repo, project) ? repo : null;
  const [linked, runs] = await Promise.all([
    githubLinked(db, userId),
    live === null ? new Map<string, RunRow>() : slotRuns(db, [live]),
  ]);
  const { facts } = cardFacts({ project, classroomName: scope.room.name, courseCode: scope.course.code, repo: row }, linked, now);
  return {
    ...facts,
    gradingMode: project.gradingMode,
    repo:
      repo === null
        ? null
        : {
            fullName: repo.fullName,
            url: htmlUrl(repo.fullName),
            invitation: repo.invitationStatus === "accepted" ? "accepted" : "pending",
            deleted: repo.deletedAt !== null,
            locked: repo.lockedAt !== null,
            ...(live === null ? { lastCommit: null, ciStatus: "none" as const, run: null, score: null } : reading(project, live, runs, now)),
          },
    release:
      project.releasedAt === null
        ? null
        : {
            at: iso(project.releasedAt),
            points: repo?.releasedPoints ?? null,
            max: repo?.releasedMax ?? null,
            grade: scoreGrade(repo?.releasedPoints ?? null, repo?.releasedMax ?? null, project.gradingScale),
            comment: repo?.releasedComment ?? null,
          },
    serverNow: iso(now),
  };
}

/**
 * `POST /app/api/student/projects/:id/invite` (F-PROJ-07): the student's own
 * resend of their pending invitation, through the staff's rule and column
 * (`resendInvitation`: pending only, once a minute per repository — the
 * minute shared with whoever asks), on a project loaded through
 * `studentProject` (a claimed student seat): on their own repository, or
 * their group's, where they alone are invited. `409 repo_unavailable`
 * before there is one.
 */
export async function studentResendInvitation(
  db: Db,
  config: AppConfig,
  project: ProjectRow,
  seat: { enrollmentId: string; userId: string },
  actor: AuditActor,
  now: Date,
  log: FastifyBaseLogger,
): Promise<ProjectInvitationResent> {
  const repo = await seatRepo(db, project, seat);
  if (repo === null) throw new ProjectError("repo_unavailable", "You have no repository on this project yet");
  return resendInvitation(db, config, project.id, repo.id, actor, now, log, seat);
}
