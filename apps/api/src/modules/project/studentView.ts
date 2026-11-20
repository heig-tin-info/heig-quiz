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
 * URL, their OWN invitation (on a group's, their grant's, never the group's
 * nor a teammate's), the commit the view stands on and its CI status,
 * the run their score comes from and that score, indicative until the
 * release (`studentScoreRun` of `@quiz/domain`: the current CI score, the
 * frozen one once their deadline is applied), the number of commits their
 * repository received from no bot by their deadline (M3-14i; the card
 * carries these too, as the state of their work) — and, once released, the
 * final score's snapshot, its grade (adjusted, ADR-135), the teacher's
 * comment and the grade adjustment's comment as the release wrote them. On
 * a project graded by `criteria` (ADR-106 §9), the
 * criteria table of their OWN repository, the domain's `student` audience
 * of `criteriaTable`: obtained empty until graded, indicative until
 * validated and released, the lock of a milestone; the rationales only
 * after the repository's definitive freeze, provisional until the release;
 * once released, the repository's contestations of its criteria — every
 * member's alike, never who filed one — and the window's closing instant
 * (ADR-139 §13).
 *
 * What it never carries: the source or distribution repository (not even
 * their existence), another student's repository or score, a teammate's
 * access to the group's repository or their GitHub login, a push or a run
 * after the deadline (once the deadline is applied or passed, the commit
 * and the CI state shown are the SELECTED run's, not the row's, which the
 * webhooks keep moving on an open repository), the review's or the
 * teacher's score before the release, the staff's flags (`to_verify`,
 * `multiple`, `malformed`, the suspended protection), a grade adjustment's
 * kind, value or base, or its comment before a release wrote it, a draft or an
 * archived project; of the criteria rows, a row's source, reason, model,
 * pass or checkpoint, a superseded row, an evidence file, a rationale
 * before the definitive freeze (a milestone's included), another
 * repository's rows, or any row of a project in another mode. The leak
 * test of `studentView.db.test.ts` searches every student response for
 * them.
 *
 * The repository is the seat's: read through a STUDENT seat only — a staff
 * seat (a teacher in the student view, ADR-018) holds none, so the view
 * shows them the project without a repository and Accept stays refused to
 * them (`studentProject`, `guards.ts`). In a group project it is the seat's
 * copy group's (`seatRepo`, `groupRepos.ts`), never the repository its
 * creator moved out of (N-SEC-20, M3-15b).
 */
import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";

import type {
  ProjectInvitationResent,
  ProjectStudentContestation,
  SentInvitation,
  StudentProject,
  ProjectSeatKind,
  StudentCriteriaRow,
  StudentProjectCard,
  StudentProjectRepo,
  StudentProjectScore,
  StudentProjectWork,
  StudentProjectWorkspace,
  ProjectRepoCollection,
} from "@quiz/contracts";
import {
  criteriaTable,
  effectiveDeadline,
  projectGraded,
  projectIsLive,
  PROJECT_VISIBLE_STATES,
  projectScoreGrade,
  type RepoAccessState,
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
import { membersContestations } from "./contestations.js";
import { criteriaStandings } from "./criterionGrades.js";
import { isLive } from "./deadline.js";
import { lastCollections } from "../codespace/service.js";
import { accessStates, seatAccess } from "./memberAccess.js";
import { slotRuns } from "./scores.js";
import { ProjectError } from "./errors.js";
import { seatRepo, seatRepos } from "./groupRepos.js";
import { syncMessage } from "./sync.js";
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
  /** Each repository's last collection at a deadline (ADR-130), the `codespace` module's record. */
  collections: Map<string, ProjectRepoCollection>;
}

/**
 * The runs and the push receipts of `repos` (M3-14i): the receipts no bot
 * pushed (`is_bot` false), by GitHub repository id — the student's own
 * pushes, never the App's nor a workflow's nor a collection's (ADR-130 §6) —
 * and each repository's last collection. Three reads, whatever the count.
 */
async function readings(db: Db, repos: readonly ProvisionedRepo[]): Promise<Readings> {
  const ids = repos.flatMap((r) => (r.githubRepoId === null ? [] : [r.githubRepoId]));
  const [runs, receipts, collections] = await Promise.all([
    slotRuns(db, repos),
    countedReceipts(db, ids),
    lastCollections(db, repos.map((r) => r.id)),
  ]);
  return { runs, receipts, collections };
}

interface CardRow {
  project: ProjectRow;
  classroomName: string;
  courseCode: string;
  /** The seat's row (their own, or their group's); null without one. */
  repo: RepoRow | null;
}

/** The card's facts, without the repository's fields: what the card and the view share. */
type CardFacts = Omit<StudentProjectCard, "invitation" | "repoFullName" | "repoUrl" | "work" | "workspace">;

/** The facts of `row` at `now`, judged by `@quiz/domain`, and the group of the Activities they fall in. */
function cardFacts(row: CardRow, linked: boolean, now: Date): { facts: CardFacts; group: StudentActivityGroup } {
  const judged = {
    startAt: row.project.startAt,
    deadlineAt: effectiveDeadline(row.repo ?? { deadlineAt: null }, row.project),
    released: row.project.releasedAt !== null,
    accepted: provisioned(row.repo) !== null,
    locked: row.repo?.lockedAt != null,
    deadlineStrategy: row.project.deadlineStrategy,
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

/**
 * The online workspace as its student reads it (ADR-047, M6-06): the mode
 * and its device level (ADR-089) when the project runs in the portal and
 * the feature is on (`codespace`), once it is open (ADR-127); null
 * otherwise. THE rule of the card and the page alike.
 */
const studentWorkspace = (project: ProjectRow, codespace: boolean): StudentProjectWorkspace | null =>
  codespace && projectIsLive(project.state) && project.workMode !== "free" ? { mode: project.workMode, devices: project.devices } : null;

/** The seat's repository while it is live: provisioned, not deleted, its project not archived. */
const liveRepo = (row: RepoRow | null, project: ProjectRow): ProvisionedRepo | null => {
  const repo = provisioned(row);
  return repo !== null && isLive(repo, project) ? repo : null;
};

/**
 * The caller's OWN invitation on their repository (F-PROJ-07, ADR-070's
 * amendment of 2026-11-19), their grant's state, whatever the kind of
 * repository (a group's row is the group's, one member in: `accepted`):
 * joined, an invitation to accept or to resend (pending or expired), or none
 * (nobody invited on the repository, no grant of theirs, no seat). A
 * teammate's is never read here.
 */
function ownInvitation(repo: RepoRow, access: RepoAccessState | null): SentInvitation | null {
  if (repo.invitationStatus === "none" || access === null || access === "unlinked") return null;
  return access === "joined" ? "accepted" : "pending";
}

/**
 * One card (F-PROJ-04): the facts, the repository's name and URL once it
 * exists and is not deleted, and the state of the work on it once it is
 * theirs, the invitation accepted (M3-14i) — the view's reading, its
 * indicative score left out once released.
 */
function card(
  row: CardRow,
  linked: boolean,
  now: Date,
  read: Readings,
  codespace: boolean,
  access: RepoAccessState | null,
): { card: StudentProjectCard; group: StudentActivityGroup } {
  const { facts, group } = cardFacts(row, linked, now);
  const live = liveRepo(row.repo, row.project);
  let work: StudentProjectWork | null = null;
  if (live?.invitationStatus === "accepted") {
    const { lastCommit, commits, ciStatus, score, collected } = reading(row.project, live, read, now);
    work = { lastCommit, commits, ciStatus, score: row.project.releasedAt === null ? score : null, collected };
  }
  return {
    group,
    card: {
      ...facts,
      invitation: live === null ? null : ownInvitation(live, access),
      repoFullName: live?.fullName ?? null,
      repoUrl: live === null ? null : htmlUrl(live.fullName),
      work,
      workspace: studentWorkspace(row.project, codespace),
    },
  };
}

/** The student's cards (`projectActivity.studentCards`), grouped as the Activities list them. */
export type StudentProjectCards = Record<StudentActivityGroup, StudentProjectCard[]>;

/**
 * The projects students see (`PROJECT_VISIBLE_STATES`: scheduled — Upcoming
 * until it opens, ADR-127 —, published, locked) of the classrooms where
 * `userId` holds a claimed seat — one classroom when `classroomId` is given
 * (the classroom page, loaded through `readableClassroom` by the route),
 * all of them otherwise (the home) — with the caller's own repository where
 * their seat is a student's. Never a draft, never an archived project
 * (F-PROJ-04, F-PROJ-16); the soonest EFFECTIVE deadline first, then by
 * name.
 */
export async function studentProjectCards(
  db: Db,
  userId: string,
  now: Date,
  { classroomId, codespace }: { classroomId?: string | undefined; codespace: boolean },
): Promise<StudentProjectCards> {
  const scope: (SQL | undefined)[] = [
    eq(enrollments.userId, userId),
    classroomId === undefined ? undefined : eq(enrollments.classroomId, classroomId),
  ];
  const rows = await db
    .select({ project: projects, classroomName: classrooms.name, courseCode: courses.code, seat: { id: enrollments.id, staff: enrollments.staff } })
    .from(enrollments)
    .innerJoin(classrooms, eq(enrollments.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .innerJoin(projects, and(eq(projects.classroomId, classrooms.id), inArray(projects.state, [...PROJECT_VISIBLE_STATES]), isNull(projects.archivedAt)))
    .where(and(...scope));
  // The repository each seat reads (`seatRepos`): its own, or its copy group's; a staff seat its own test repository (ADR-077).
  const seats = await seatRepos(
    db,
    rows.map((r) => r.project),
    rows.map((r) => r.seat.id),
  );
  const cards = rows.map(({ seat, ...row }) => ({ ...row, seatId: seat.id, repo: seats.of(row.project.id, seat.id) }));
  const deadline = (row: CardRow) => effectiveDeadline(row.repo ?? { deadlineAt: null }, row.project).getTime();
  cards.sort((a, b) => deadline(a) - deadline(b) || (a.project.name < b.project.name ? -1 : a.project.name > b.project.name ? 1 : 0));
  const [linked, read, access] = await Promise.all([
    rows.length > 0 && githubLinked(db, userId),
    readings(db, cards.flatMap((row) => liveRepo(row.repo, row.project) ?? [])),
    accessStates(db, cards.flatMap((row) => (row.repo === null ? [] : [{ repoId: row.repo.id, enrollmentId: row.seatId }]))),
  ]);
  const groups: StudentProjectCards = { open: [], upcoming: [], past: [] };
  for (const { seatId, ...row } of cards) {
    const placed = card(row, linked, now, read, codespace, row.repo === null ? null : access({ repoId: row.repo.id, enrollmentId: seatId }));
    groups[placed.group].push(placed.card);
  }
  return groups;
}

/** What the view shows of a repository's commits and runs: the commit it stands on, its CI state, the commit count, the selected run and its score. */
type RepoReading = Pick<StudentProjectRepo, "lastCommit" | "commits" | "ciStatus" | "run" | "score" | "collected">;

/**
 * The repository as the student reads it (F-PROJ-15, N-SEC-20): the run
 * and the commit by `studentScoreRun` and `studentCiReading` of
 * `@quiz/domain` — the stored head before the deadline, the SELECTED run
 * alone once it is over — the run's score, indicative (no score under
 * grading `none`), and the commits of the student's pushes received by
 * their effective deadline (`studentCommitCount`, M3-14i).
 */
function reading(project: ProjectRow, repo: ProvisionedRepo, { runs, receipts, collections }: Readings, now: Date): RepoReading {
  const slot = (id: string | null) => (id === null ? null : (runs.get(id) ?? null));
  const chosen = studentScoreRun({
    deadlineAppliedAt: repo.deadlineAppliedAt,
    current: slot(repo.currentGradeRunId),
    frozen: slot(repo.frozenGradeRunId),
  });
  const deadlineAt = effectiveDeadline(repo, project);
  const ci = studentCiReading(repo, chosen?.run ?? null, deadlineAt, now);
  // Collected for the deadline that applies now (ADR-130 §7): an earlier deadline's, once extended, says nothing.
  const collection = collections.get(repo.id);
  const collected = collection?.outcome === "collected" && collection.deadlineAt === deadlineAt.toISOString();
  const stored: Pick<RepoReading, "lastCommit" | "commits" | "ciStatus" | "collected"> = {
    lastCommit: ci.lastCommit === null ? null : { sha: ci.lastCommit.sha, at: isoOrNull(ci.lastCommit.at) },
    commits: repoCommitCount(project, repo, receipts),
    ciStatus: ci.ciStatus,
    collected,
  };
  if (chosen === null) return { ...stored, run: null, score: null };
  const { run, frozen } = chosen;
  const score: StudentProjectScore | null =
    projectGraded(project.gradingMode) && run.parseStatus === "ok" && run.points !== null
      ? {
          points: run.points,
          max: run.max,
          // The CI's share of a project graded by criteria has no grade (`ciShareOnly`, product owner 2026-11-18).
          grade: projectScoreGrade(project, "ci", run.points, run.max),
          frozen,
        }
      : null;
  return {
    ...stored,
    run: { sha: run.headSha, url: runUrl(repo.fullName, run.workflowRunId), conclusion: run.conclusion, completedAt: iso(run.completedAt) },
    score,
  };
}

/**
 * The criteria table of `repo` (ADR-106 §9): null unless its project is
 * graded by `criteria` with a snapshot (`criteriaStandings` reads none
 * otherwise). Frozen and released by the server's columns: the
 * repository's definitive freeze, the project's release. With it, the
 * repository's contestations, every member's alike, and whether each
 * criterion may be contested now (ADR-139 §13, `membersContestations`).
 */
async function studentCriteria(
  db: Db,
  project: ProjectRow,
  repo: ProvisionedRepo | null,
  seat: { id: string } | null,
  now: Date,
): Promise<{ criteria: StudentCriteriaRow[] | null; contestations: ProjectStudentContestation[] }> {
  if (repo === null || project.gradingMode !== "criteria") return { criteria: null, contestations: [] };
  const standing = (await criteriaStandings(db, [repo])).get(repo.id);
  const { contestations, contestable } = await membersContestations(db, project, repo, seat, standing, now);
  if (!standing) return { criteria: null, contestations };
  const table = criteriaTable(standing.snapshot, standing.rows, {
    audience: "student",
    frozen: repo.frozenAt !== null,
    released: project.releasedAt !== null,
  });
  return { criteria: table.map((row) => ({ ...row, contestable: contestable(row.criterionId) })), contestations };
}

/**
 * `GET /app/api/student/projects/:id` (F-PROJ-15): the student payload of
 * the project `scope` loaded through `studentProjectView` (invariant 6),
 * for `userId` — the caller, or the impersonated student (ADR-034). A
 * repository deleted on GitHub is still theirs to read, said `deleted`,
 * with nothing of its runs. `codespace`: the online workspace is on
 * (`CODESPACE_URL` set), so the project's mode is said (ADR-047, M6-06).
 */
export async function studentProject(
  db: Db,
  scope: StudentProjectScope,
  userId: string,
  now: Date,
  { codespace }: { codespace: boolean },
): Promise<StudentProject> {
  const { project } = scope;
  const row = scope.seat !== null ? await seatRepo(db, project, scope.seat.id) : null;
  const seat = scope.seat === null ? null : scope.seat.staff ? ("staff" as const) : ("student" as const);
  const repo = provisioned(row);
  const live = liveRepo(row, project);
  const [linked, read, { criteria, contestations }, access] = await Promise.all([
    githubLinked(db, userId),
    readings(db, live === null ? [] : [live]),
    studentCriteria(db, project, repo, scope.seat, now),
    repo === null || scope.seat === null ? null : seatAccess(db, { repoId: repo.id, enrollmentId: scope.seat.id }),
  ]);
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
            invitation: ownInvitation(repo, access),
            deleted: repo.deletedAt !== null,
            // A group's repository (ADR-048): its contestations are the group's (ADR-139 §13).
            group: repo.groupId !== null,
            locked: repo.lockedAt !== null,
            ...(live === null
              ? { lastCommit: null, commits: 0, ciStatus: "none" as const, run: null, score: null, collected: false }
              : reading(project, live, read, now)),
          },
    release:
      project.releasedAt === null
        ? null
        : {
            at: iso(project.releasedAt),
            points: repo?.releasedPoints ?? null,
            max: repo?.releasedMax ?? null,
            grade: repo?.releasedGrade == null ? null : { grade: repo.releasedGrade },
            comment: repo?.releasedComment ?? null,
            // ADR-135: the justification as the release wrote it; never the adjustment's kind, value nor base.
            adjustmentComment: repo?.releasedAdjustmentComment ?? null,
          },
    criteria,
    // ADR-132 §10: the latest sync's message and its date, nothing else of the sync (N-SEC-20).
    projectUpdate: syncMessage(project),
    // ADR-139 §13: the window's instant in `criteria` mode only, and the repository's own contestations.
    contestationClosesAt: project.gradingMode === "criteria" ? isoOrNull(project.contestationClosesAt) : null,
    contestations,
    workspace: studentWorkspace(project, codespace),
    serverNow: iso(now),
  };
}

/**
 * `POST /app/api/student/projects/:id/invite` (F-PROJ-07): the student's own
 * resend of their invitation, through the staff's rule and column
 * (`resendInvitation`: once a minute per repository — the minute shared
 * with whoever asks), on a project loaded through `studentProject` (a
 * claimed student seat): on their own repository, its invitation pending,
 * or their group's while they are out of it, where they alone are invited.
 * `409 repo_unavailable` before there is one.
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
