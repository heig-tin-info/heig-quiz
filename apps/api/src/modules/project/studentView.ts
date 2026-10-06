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
 * frozen one once their deadline is applied), the number of commits their
 * repository received from no bot by their deadline (M3-14i; the card carries these
 * too, as the state of their work) — and, once released, the
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
import { and, eq, inArray, isNull, ne, type SQL } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";

import type {
  ProjectInvitationResent,
  StudentProject,
  ProjectSeatKind,
  StudentProjectCard,
  StudentProjectRepo,
  StudentProjectScore,
  StudentProjectWork,
} from "@quiz/contracts";
import {
  effectiveDeadline,
  scoreGrade,
  studentCiReading,
  studentProjectGroup,
  studentProjectStatus,
  studentScoreRun,
  type CountedReceipt,
  type StudentActivityGroup,
} from "@quiz/domain";

import type { AuditActor } from "../../audit.js";
import { iso, isoOrNull } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { classrooms, courses, enrollments, githubAccounts, projectGradeRuns, projects } from "../../db/schema.js";
import { htmlUrl } from "../../github/git.js";
import type { StudentProjectScope } from "../guards.js";
import { countedReceipts, repoCommitCount } from "./commits.js";
import { isLive } from "./deadline.js";
import { slotRuns } from "./detail.js";
import { ProjectError } from "./errors.js";
import { seatRepo, seatRepos } from "./groupRepos.js";
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

/** What a reading of live repositories needs beside the rows: their slots' runs, and their receipts of no bot's push. */
interface Readings {
  runs: Map<string, RunRow>;
  receipts: Map<number, CountedReceipt[]>;
}

/**
 * The runs and the push receipts of `repos` (M3-14i): the receipts no bot
 * pushed (`is_bot` false), by GitHub repository id — the student's own
 * pushes, never the App's nor a workflow's. Two reads, whatever the count.
 */
async function readings(db: Db, repos: readonly ProvisionedRepo[]): Promise<Readings> {
  const ids = repos.flatMap((r) => (r.githubRepoId === null ? [] : [r.githubRepoId]));
  const [runs, receipts] = await Promise.all([slotRuns(db, repos), countedReceipts(db, ids)]);
  return { runs, receipts };
}

interface CardRow {
  project: ProjectRow;
  classroomName: string;
  courseCode: string;
  /** The seat's row (their own, or their group's); null without one. */
  repo: RepoRow | null;
}

/** The card's facts, without the repository's fields: what the card and the view share. */
type CardFacts = Omit<StudentProjectCard, "invitation" | "repoFullName" | "repoUrl" | "work">;

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

/** The seat's repository while it is live: provisioned, not deleted, its project not archived. */
const liveRepo = (row: RepoRow | null, project: ProjectRow): ProvisionedRepo | null => {
  const repo = provisioned(row);
  return repo !== null && isLive(repo, project) ? repo : null;
};

/**
 * One card (F-PROJ-04): the facts, the repository's name and URL once it
 * exists and is not deleted, and the state of the work on it once it is
 * theirs, the invitation accepted (M3-14i) — the view's reading, its
 * indicative score left out once released.
 */
function card(row: CardRow, linked: boolean, now: Date, read: Readings): { card: StudentProjectCard; group: StudentActivityGroup } {
  const { facts, group } = cardFacts(row, linked, now);
  const live = liveRepo(row.repo, row.project);
  let work: StudentProjectWork | null = null;
  if (live?.invitationStatus === "accepted") {
    const { lastCommit, commits, ciStatus, score } = reading(row.project, live, read, now);
    work = { lastCommit, commits, ciStatus, score: row.project.releasedAt === null ? score : null };
  }
  return {
    group,
    card: {
      ...facts,
      invitation: live === null || live.invitationStatus === "none" ? null : live.invitationStatus,
      repoFullName: live?.fullName ?? null,
      repoUrl: live === null ? null : htmlUrl(live.fullName),
      work,
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
  const rows = await db
    .select({ project: projects, classroomName: classrooms.name, courseCode: courses.code, seat: { id: enrollments.id, staff: enrollments.staff } })
    .from(enrollments)
    .innerJoin(classrooms, eq(enrollments.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .innerJoin(projects, and(eq(projects.classroomId, classrooms.id), ne(projects.state, "draft"), isNull(projects.archivedAt)))
    .where(and(...scope));
  // The repository each seat reads (`seatRepos`): its own, or its copy group's; a staff seat its own test repository (ADR-077).
  const seats = await seatRepos(
    db,
    rows.map((r) => r.project),
    rows.map((r) => r.seat.id),
  );
  const cards = rows.map(({ seat, ...row }) => ({ ...row, repo: seats.of(row.project.id, seat.id) }));
  const deadline = (row: CardRow) => effectiveDeadline(row.repo ?? { deadlineAt: null }, row.project).getTime();
  cards.sort((a, b) => deadline(a) - deadline(b) || (a.project.name < b.project.name ? -1 : a.project.name > b.project.name ? 1 : 0));
  const [linked, read] = await Promise.all([
    rows.length > 0 && githubLinked(db, userId),
    readings(db, cards.flatMap((row) => liveRepo(row.repo, row.project) ?? [])),
  ]);
  const groups: StudentProjectCards = { open: [], upcoming: [], past: [] };
  for (const row of cards) {
    const placed = card(row, linked, now, read);
    groups[placed.group].push(placed.card);
  }
  return groups;
}

/** What the view shows of a repository's commits and runs: the commit it stands on, its CI state, the commit count, the selected run and its score. */
type RepoReading = Pick<StudentProjectRepo, "lastCommit" | "commits" | "ciStatus" | "run" | "score">;

/**
 * The repository as the student reads it (F-PROJ-15, N-SEC-20): the run
 * and the commit by `studentScoreRun` and `studentCiReading` of
 * `@quiz/domain` — the stored head before the deadline, the SELECTED run
 * alone once it is over — the run's score, indicative (no score under
 * grading `none`), and the commits of the student's pushes received by
 * their effective deadline (`studentCommitCount`, M3-14i).
 */
function reading(project: ProjectRow, repo: ProvisionedRepo, { runs, receipts }: Readings, now: Date): RepoReading {
  const slot = (id: string | null) => (id === null ? null : (runs.get(id) ?? null));
  const chosen = studentScoreRun({
    deadlineAppliedAt: repo.deadlineAppliedAt,
    current: slot(repo.currentGradeRunId),
    frozen: slot(repo.frozenGradeRunId),
  });
  const deadlineAt = effectiveDeadline(repo, project);
  const ci = studentCiReading(repo, chosen?.run ?? null, deadlineAt, now);
  const stored: Pick<RepoReading, "lastCommit" | "commits" | "ciStatus"> = {
    lastCommit: ci.lastCommit === null ? null : { sha: ci.lastCommit.sha, at: isoOrNull(ci.lastCommit.at) },
    commits: repoCommitCount(project, repo, receipts),
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
  const row = scope.seat !== null ? await seatRepo(db, project, scope.seat.id) : null;
  const seat = scope.seat === null ? null : scope.seat.staff ? ("staff" as const) : ("student" as const);
  const repo = provisioned(row);
  const live = liveRepo(row, project);
  const [linked, read] = await Promise.all([githubLinked(db, userId), readings(db, live === null ? [] : [live])]);
  const { facts } = cardFacts({ project, classroomName: scope.room.name, courseCode: scope.course.code, repo: row }, linked, now);
  return {
    ...facts,
    seat,
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
            ...(live === null
              ? { lastCommit: null, commits: 0, ciStatus: "none" as const, run: null, score: null }
              : reading(project, live, read, now)),
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
  enrollmentId: string,
  actor: AuditActor,
  now: Date,
  log: FastifyBaseLogger,
): Promise<ProjectInvitationResent> {
  const repo = await seatRepo(db, project, enrollmentId);
  if (repo === null) throw new ProjectError("repo_unavailable", "You have no repository on this project yet");
  return resendInvitation(db, config, project.id, repo.id, actor, now, log, enrollmentId);
}
