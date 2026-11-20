/**
 * Contestations of a project's criteria (ADR-139 §13, Lot 1b): on a released
 * project graded by criteria, a member of a repository contests ONE
 * criterion — its points and its rationale — once, with a reason; the course
 * owner answers once, `accepted` or `refused`, an acceptance possibly with
 * the criterion's new points written by the teacher's criterion write in the
 * same transaction (a `manual` row, still proposed: indicative to the
 * members until the owner validates and releases again, decision 9).
 *
 * The rule — the states, the texts, what may be contested, the window — is
 * `@quiz/domain`'s (`contestation.ts`), unchanged, shared with an exam's
 * questions (`modules/grading/contestations.ts`). A criterion maps onto its
 * `ContestedUnit` here ({@link criterionUnit}): shown once the project is
 * released, counted for a live repository read through a student seat,
 * counting while the criterion is in the snapshot, graded by its VALIDATED
 * row in force, full at the top of its awarded range (`awardedRange`): a
 * criterion's maximum, a bonus's points, a penalty's 0.
 *
 * The filing is decided by ONE conditional INSERT … SELECT on the
 * database's clock (invariant 5); the views' `contestable` flag only offers
 * the control. On a group repository the contestation is the repository's:
 * any member files it, every member reads it — in the student project
 * payload of that repository only (`studentView.ts`, N-SEC-20) — and the
 * filer is named to nobody. The staff read them on their own route
 * (`GET …/contestations`), which no token reaches: nothing of a student's
 * words leaves through the MCP server before Lot 2 (§14).
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type {
  ContestationWindowBody,
  NotContestable,
  ProjectContestationResolveBody,
  ProjectContestations,
  ProjectGradingRepo,
  ProjectStaffContestation,
  ProjectStudentContestation,
  WindowInstantRefused,
} from "@quiz/contracts";
import {
  awardedRange,
  contestationWindowOpen,
  contestedUnit,
  criterionInForce,
  currentCriterionRows,
  unitRefusal,
  windowExtendRefusal,
  type ContestedUnit,
  type ContestRefusal,
  type CriteriaLeaf,
  type CriterionGradeLike,
} from "@quiz/domain";

import { isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import {
  classrooms,
  projectContestations,
  projectCriteria,
  projectCriterionGrades,
  projectRepos,
  projects,
} from "../../db/schema.js";
import { studentContestationOf } from "../grading/service.js";
import { classroomStaffIds } from "../guards.js";
import { notFoundError } from "../http.js";
import { notifyUsers } from "../notifications/service.js";
import { gradeCriterion } from "./criteriaGrading.js";
import type { GradeWriter } from "./grades.js";
import { criteriaStandings } from "./criterionGrades.js";
import { isLive, LIVE } from "./deadline.js";
import { ProjectError } from "./errors.js";
import { projectsChanged, repoChanged } from "./events.js";
import { repoMembers } from "./groupRepos.js";
import type { RepoRow } from "./repos.js";
import type { ProjectRow } from "./views.js";

export type ProjectContestationRecord = typeof projectContestations.$inferSelect;

/**
 * The members of a repository who act on its contestations — file them,
 * read them, are told of their answers (ADR-139 §13): its readers by THE
 * rule of `repoMembers` (its student, or its copy group's members whose
 * departure is not pending, a live individual repository's holder kept
 * out), through a student seat (a staff seat's test repository has none).
 */
const memberSeats = async (db: Db, repo: RepoRow, project: Pick<ProjectRow, "classroomId">) =>
  (await repoMembers(db, repo, project.classroomId)).filter((m) => !m.staff);

// --- The unit and the window ------------------------------------------------

/** A window applies: the project is graded by criteria and released (the owner's acts are offered then). */
export const projectWindowApplies = (project: Pick<ProjectRow, "gradingMode" | "releasedAt">): boolean =>
  project.gradingMode === "criteria" && project.releasedAt !== null;

/** The window holds at `now`, on the server's clock: what the views offer; the filing reads the database's. */
export const projectWindowOpen = (project: Pick<ProjectRow, "gradingMode" | "releasedAt" | "contestationClosesAt">, now: Date): boolean =>
  projectWindowApplies(project) && contestationWindowOpen({ released: true, closesAt: project.contestationClosesAt }, now);

/**
 * The facts of one criterion of one repository of a RELEASED project
 * (`contestedUnit` of `@quiz/domain`) — the one builder of the filing and
 * of the members' view, whose callers decided the window and the release:
 * `counted` for a member of a live repository (`memberSeats`; a staff
 * seat's test repository, ADR-077, counts nowhere); `counting` while the
 * criterion is in the snapshot; its grading in force `criterionInForce`
 * (`@quiz/domain`: the validated row against the top of its range).
 */
export function criterionUnit(facts: {
  counted: boolean;
  leaf: Pick<CriteriaLeaf, "maxPoints" | "bonusPoints"> | undefined;
  rows: readonly CriterionGradeLike[];
  criterionId: string;
}): ContestedUnit {
  return contestedUnit({
    shown: true,
    counted: facts.counted,
    counting: facts.leaf !== undefined,
    grading: criterionInForce(facts.leaf, currentCriterionRows(facts.rows).get(facts.criterionId)),
  });
}

// --- The two readings of a row ----------------------------------------------

/** What the repository's members read — an exam's reading (`studentContestationOf`) and the criterion at the filing. Never who filed it. */
export const studentProjectContestationOf = (row: ProjectContestationRecord): ProjectStudentContestation => ({
  ...studentContestationOf(row),
  criterionId: row.criterionId,
  criterionDescription: row.criterionDescription,
  pointsAtFiling: row.pointsAtFiling,
  maxAtFiling: row.maxAtFiling,
  bonusAtFiling: row.bonusAtFiling,
});

/** What the staff read: the same, its id, its repository, whether that repository is live and its criterion still in the snapshot. */
export const staffProjectContestationOf = (
  row: ProjectContestationRecord,
  facts: { counted: boolean; inSnapshot: boolean },
): ProjectStaffContestation => ({
  ...studentProjectContestationOf(row),
  id: row.id,
  repoId: row.repoId,
  ...facts,
});

/** The contestations of one repository, by criterion: its members' project page. */
export async function repoContestations(db: Db, repoId: string): Promise<Map<string, ProjectContestationRecord>> {
  const rows = await db.select().from(projectContestations).where(eq(projectContestations.repoId, repoId));
  return new Map(rows.map((row) => [row.criterionId, row]));
}

/**
 * The OPEN contestations of the given projects, by project, on their live
 * repositories (a deleted one, or an archived project's, in none): the
 * gradebook's column, read by join.
 */
export async function openProjectContestations(db: Db, projectIds: readonly string[]): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();
  const rows = await db
    .select({ projectId: projectRepos.projectId, n: sql<number>`count(*)::int` })
    .from(projectContestations)
    .innerJoin(projectRepos, eq(projectRepos.id, projectContestations.repoId))
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .where(and(inArray(projectRepos.projectId, [...projectIds]), eq(projectContestations.state, "open"), LIVE))
    .groupBy(projectRepos.projectId);
  return new Map(rows.map((row) => [row.projectId, row.n]));
}

/** The leaves of the project's snapshot, by id; empty without one. */
async function snapshotLeaves(db: Db, projectId: string): Promise<Map<string, CriteriaLeaf>> {
  const [row] = await db.select({ criteria: projectCriteria.criteria }).from(projectCriteria).where(eq(projectCriteria.projectId, projectId));
  return new Map((row?.criteria.leaves ?? []).map((leaf) => [leaf.id, leaf]));
}

/**
 * `GET /app/api/projects/:id/contestations` (staff): the window, the open
 * counts per live repository, and every contestation of the
 * project's repositories, the open ones first, then the newest.
 */
export async function projectContestationsView(db: Db, project: ProjectRow): Promise<ProjectContestations> {
  const [rows, leaves] = await Promise.all([
    db
      .select({ contestation: projectContestations, repo: projectRepos })
      .from(projectContestations)
      .innerJoin(projectRepos, eq(projectRepos.id, projectContestations.repoId))
      .where(eq(projectRepos.projectId, project.id))
      .orderBy(sql`${projectContestations.state} = 'open' desc`, desc(projectContestations.filedAt)),
    snapshotLeaves(db, project.id),
  ]);
  const contestations = rows.map(({ contestation, repo }) =>
    staffProjectContestationOf(contestation, { counted: isLive(repo, project), inSnapshot: leaves.has(contestation.criterionId) }),
  );
  const openByRepo: Record<string, number> = {};
  for (const c of contestations) if (c.state === "open" && c.counted) openByRepo[c.repoId] = (openByRepo[c.repoId] ?? 0) + 1;
  return {
    applies: projectWindowApplies(project),
    closesAt: isoOrNull(project.contestationClosesAt),
    openByRepo,
    contestations,
  };
}

// --- Filing ------------------------------------------------------------------

/** `409 not_contestable`, its body the contract's (`NotContestable`). */
const notContestable = (reason: ContestRefusal) =>
  new ProjectError("not_contestable", "This criterion cannot be contested", { reason } satisfies Pick<NotContestable, "reason">);

/**
 * A member's one request on one criterion of their repository (ADR-139
 * §13). `repo` is the seat's (`seatRepo`), null without one. The loaded
 * rows only CHOOSE a refusal: `409 contestation_closed` when the project is
 * not released, not graded by criteria or has no window; a 404 for a seat
 * with no repository and for a criterion the snapshot lacks — the same
 * answer, so a classmate cannot probe the criteria's ids; `409
 * not_contestable` with the domain's `reason` (`not_counted`: no member of
 * a live repository by `memberSeats`, a departing group member included,
 * checked here, before the INSERT; `pending`; `full_points`). The decision
 * is ONE conditional INSERT … SELECT: the window on the database's clock —
 * `now()` before the stored closing instant — a released project graded by
 * criteria, its classroom not archived, the repository live (`LIVE`), the
 * criterion in the snapshot, and its validated row in force below the top
 * of its range, read in the same statement (`grade_at_filing_id`). Its miss is named afterwards: `409
 * contestation_exists` (one per repository and criterion), `409
 * classroom_archived`, `409 not_contestable` (`pending`, `full_points`: it
 * changed meanwhile), else `contestation_closed`.
 */
export async function fileProjectContestation(
  db: Db,
  input: {
    project: ProjectRow;
    repo: RepoRow | null;
    seat: { id: string; userId: string };
    criterionId: string;
    reason: string;
  },
): Promise<ProjectContestationRecord> {
  const { project, repo, seat, criterionId } = input;
  if (!projectWindowApplies(project) || project.contestationClosesAt === null) throw new ProjectError("contestation_closed");
  if (repo === null) throw notFoundError("criterion");
  const leaf = (await snapshotLeaves(db, project.id)).get(criterionId);
  if (!leaf) throw notFoundError("criterion");
  const counted = isLive(repo, project) && (await memberSeats(db, repo, project)).some((m) => m.enrollmentId === seat.id);
  const standing = (await criteriaStandings(db, [repo])).get(repo.id);
  const refusal = unitRefusal(criterionUnit({ counted, leaf, rows: standing?.rows ?? [], criterionId }));
  if (refusal !== null) throw notContestable(refusal);

  const best = awardedRange(leaf)[1];
  // Every column, in the table's order (an INSERT … SELECT names them all).
  const [row] = await db
    .insert(projectContestations)
    .select(
      sql`select ${randomUUID()}::uuid, ${repo.id}::uuid, ${criterionId}, ${leaf.description},
        ${projectCriterionGrades.points}, ${leaf.maxPoints}::numeric, ${leaf.bonusPoints ?? null}::numeric, ${projectCriterionGrades.id},
        ${input.reason}, ${seat.userId}::uuid, now(), 'open', '', null::uuid, null::timestamptz, null::uuid
      from ${projectCriterionGrades}
      inner join ${projectRepos} on ${projectRepos.id} = ${projectCriterionGrades.repoId}
      inner join ${projects} on ${projects.id} = ${projectRepos.projectId}
      inner join ${classrooms} on ${classrooms.id} = ${projects.classroomId}
      inner join ${projectCriteria} on ${projectCriteria.projectId} = ${projects.id}
      where ${projectCriterionGrades.repoId} = ${repo.id}::uuid and ${projectCriterionGrades.criterionId} = ${criterionId}
        and ${projectCriterionGrades.state} = 'validated' and ${projectCriterionGrades.points} < ${best}::numeric
        and ${projects.gradingMode} = 'criteria' and ${projects.releasedAt} is not null
        and now() < ${projects.contestationClosesAt}
        and ${classrooms.archivedAt} is null and ${LIVE}
        and exists (select 1 from jsonb_array_elements(${projectCriteria.criteria}->'leaves') leaf where leaf->>'id' = ${criterionId})`,
    )
    .onConflictDoNothing({ target: [projectContestations.repoId, projectContestations.criterionId] })
    .returning();
  if (row) return row;
  if ((await repoContestations(db, repo.id)).has(criterionId)) throw new ProjectError("contestation_exists");
  const [room] = await db.select({ archivedAt: classrooms.archivedAt }).from(classrooms).where(eq(classrooms.id, project.classroomId));
  if (room?.archivedAt != null) throw new ProjectError("classroom_archived");
  const again = (await criteriaStandings(db, [repo])).get(repo.id);
  const late = unitRefusal(criterionUnit({ counted: true, leaf, rows: again?.rows ?? [], criterionId }));
  if (late !== null) throw notContestable(late);
  throw new ProjectError("contestation_closed");
}

// --- The members' reading ------------------------------------------------------

/**
 * What the student payload of `repo` carries of the contestations (ADR-139
 * §13), for a member of it by `memberSeats` only — a departing group
 * member, a staff seat, nobody else reads any: its own, every member's
 * alike, and, per criterion, whether it may be contested now — the
 * domain's rule and the window on the server's clock, no contestation filed
 * yet (an offer the filing decides again).
 */
export async function membersContestations(
  db: Db,
  project: ProjectRow,
  repo: RepoRow | null,
  seat: { id: string } | null,
  standing: { rows: readonly CriterionGradeLike[]; snapshot: { leaves: readonly CriteriaLeaf[] } } | undefined,
  now: Date,
): Promise<{ contestations: ProjectStudentContestation[]; contestable: (criterionId: string) => boolean }> {
  const none = { contestations: [], contestable: () => false };
  if (repo === null || seat === null || project.gradingMode !== "criteria") return none;
  if (!(await memberSeats(db, repo, project)).some((m) => m.enrollmentId === seat.id)) return none;
  const filed = await repoContestations(db, repo.id);
  const open = projectWindowOpen(project, now);
  const counted = isLive(repo, project);
  const leaves = new Map((standing?.snapshot.leaves ?? []).map((leaf) => [leaf.id, leaf]));
  return {
    contestations: [...filed.values()].sort((a, b) => a.filedAt.getTime() - b.filedAt.getTime()).map(studentProjectContestationOf),
    contestable: (criterionId) =>
      open &&
      !filed.has(criterionId) &&
      unitRefusal(criterionUnit({ counted, leaf: leaves.get(criterionId), rows: standing?.rows ?? [], criterionId })) === null,
  };
}

// --- Answering ---------------------------------------------------------------

/**
 * The contestation `contestationId` of a repository of `project`, with its
 * repository; the 404 of a missing one otherwise (the project is the
 * route's, loaded through the staff's access, invariant 6).
 */
export async function contestationOfProject(
  db: Db,
  project: ProjectRow,
  contestationId: string,
): Promise<{ contestation: ProjectContestationRecord; repo: RepoRow }> {
  const [row] = await db
    .select({ contestation: projectContestations, repo: projectRepos })
    .from(projectContestations)
    .innerJoin(projectRepos, eq(projectRepos.id, projectContestations.repoId))
    .where(and(eq(projectContestations.id, contestationId), eq(projectRepos.projectId, project.id)));
  if (!row) throw notFoundError("contestation");
  return row;
}

/**
 * The owner's one answer (ADR-139 §13, decision 9); the contract checked
 * that it explains itself (`answerExplained`). A contestation whose
 * criterion left the snapshot can only be refused (`409
 * criterion_removed`). Without points, one conditional UPDATE (`state =
 * 'open'`: else `409 not_open`), the criterion's row in force recorded
 * beside it. With points, the teacher's criterion write (`gradeCriterion`:
 * a `manual` row still proposed, its range, the repository frozen for
 * good) and the answer written in ITS transaction, after the new row: both
 * commit, or neither — a second answer racing this one finds the row
 * answered and rolls its points back (`409 not_open`). The repository waits
 * for the owner's validation, and the grade for their next release.
 */
export async function resolveProjectContestation(
  db: Db,
  input: {
    project: ProjectRow;
    contestation: ProjectContestationRecord;
    repo: RepoRow;
    body: ProjectContestationResolveBody;
    writer: GradeWriter;
  },
): Promise<{ row: ProjectContestationRecord; contestation: ProjectStaffContestation; graded: ProjectGradingRepo | null; before: string | null }> {
  const { project, contestation, repo, body, writer } = input;
  const inSnapshot = (await snapshotLeaves(db, project.id)).has(contestation.criterionId);
  if (!inSnapshot && body.verdict === "accepted") {
    throw new ProjectError("criterion_removed", "The criterion left the project's criteria: this contestation can only be refused");
  }
  const standing = (await criteriaStandings(db, [repo])).get(repo.id);
  const beforeId = (standing && currentCriterionRows(standing.rows).get(contestation.criterionId)?.id) ?? null;
  const staffOf = (row: ProjectContestationRecord) => staffProjectContestationOf(row, { counted: isLive(repo, project), inSnapshot });
  const answer = (tx: Pick<Db, "update">, gradeId: string | null) =>
    tx
      .update(projectContestations)
      .set({ state: body.verdict, reply: body.reply, resolvedBy: writer.userId, resolvedAt: writer.now, gradeAtResolutionId: gradeId })
      .where(and(eq(projectContestations.id, contestation.id), eq(projectContestations.state, "open")))
      .returning();

  if (body.points === undefined) {
    const [row] = await answer(db, beforeId);
    if (!row) throw new ProjectError("not_open", "This contestation was answered already");
    return { row, contestation: staffOf(row), graded: null, before: beforeId };
  }
  let row: ProjectContestationRecord | undefined;
  const graded = await gradeCriterion(
    db,
    project,
    repo,
    contestation.criterionId,
    { points: body.points, ...(body.rationale === undefined ? {} : { rationale: body.rationale }) },
    writer,
    async (tx, written) => {
      [row] = await answer(tx, written[0]!.id);
      if (!row) throw new ProjectError("not_open", "This contestation was answered already");
    },
  );
  return { row: row!, contestation: staffOf(row!), graded, before: beforeId };
}

// --- Who is told ---------------------------------------------------------------

/**
 * A filing told (ADR-139 §13, ADR-030): the course's staff, folded per
 * project (`project_contestation_filed`, a count, never whose nor why), and
 * their screens re-read (`course:<id>`) — never the classroom, where every
 * classmate listens, nor the members, who have the request's reply
 * (N-SEC-20). Best-effort, after the write.
 */
export async function tellFiled(db: Db, project: ProjectRow, courseId: string): Promise<void> {
  projectsChanged([courseId]);
  await notifyUsers(db, await classroomStaffIds(db, project.classroomId), {
    kind: "project_contestation_filed",
    projectId: project.id,
    projectTitle: project.name,
    count: 1,
  });
}

/**
 * An answer told: every member of the repository (`memberSeats`, the
 * one rule of who reads its contestations), and their screens and
 * the staff's re-read (`user:<id>`, `course:<id>`) — never the classroom.
 * Ids and the title only: the verdict and the reply are read on the
 * project page.
 */
export async function tellResolved(db: Db, project: ProjectRow, repo: RepoRow, courseId: string): Promise<void> {
  const members = (await memberSeats(db, repo, project)).map((m) => m.userId);
  repoChanged(courseId, members);
  await notifyUsers(db, members, { kind: "project_contestation_resolved", projectId: project.id, projectTitle: project.name });
}

// --- The window --------------------------------------------------------------

/**
 * `PUT /app/api/projects/:id/contestation-window`, the owner's two acts
 * (ADR-139 §13, as Lot 1's §2): close now (the server's clock), or extend
 * to a later instant (`windowExtendRefusal`: `422 window_instant` with the
 * domain's `reason`); extending may reopen a closed window, or open one
 * where the release opened none (0 days). On a released project graded by
 * criteria only, read again by the UPDATE (`409 window_unavailable`). The
 * open contestations are left as they are: closing stops new ones only.
 */
export async function changeProjectContestationWindow(db: Db, project: ProjectRow, body: ContestationWindowBody, now: Date): Promise<Date> {
  if (!projectWindowApplies(project)) throw new ProjectError("window_unavailable", "This project has no contestation window to change");
  const closesAt = body.action === "close" ? now : new Date(body.closesAt);
  if (body.action === "extend") {
    const refusal = windowExtendRefusal(closesAt, now);
    if (refusal !== null) {
      throw new ProjectError("window_instant", "The window closes at a later instant, at most 90 days ahead", {
        reason: refusal,
      } satisfies Pick<WindowInstantRefused, "reason">);
    }
  }
  const [row] = await db
    .update(projects)
    .set({ contestationClosesAt: closesAt })
    .where(and(eq(projects.id, project.id), eq(projects.gradingMode, "criteria"), sql`${projects.releasedAt} is not null`))
    .returning({ id: projects.id });
  if (!row) throw new ProjectError("window_unavailable", "This project has no contestation window to change");
  return closesAt;
}
