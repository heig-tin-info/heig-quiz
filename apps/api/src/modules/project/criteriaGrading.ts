/**
 * The teacher's grading screen of a project graded by criteria (ADR-106
 * §6, §8, F-PROJ-25, F-PROJ-26): a repository's entry — its criteria table,
 * its last evidence, its validation; also `GET …/repos/:rid/criteria` —,
 * the screen's payload, a teacher's points for one criterion, and the
 * validation of one repository or of every one.
 *
 * - **A teacher's edit is not a validation**: a `manual` row, `proposed`,
 *   written through the ONE writer (`writeCriterionGrades`), which lets it
 *   supersede whatever stands on its criterion.
 * - **Validate** is the writer's own transition (`validateProposals`): under
 *   the repositories' locks, each proposal superseded by a validated copy;
 *   refused as a whole while a criterion has no row (`409
 *   criteria_incomplete`) — a teacher-only criterion is never defaulted.
 *
 * A criterion whose current row a CI pass set, with a log stored for it,
 * is marked `ciLog`; the log is read on demand from that pass's results
 * (`criterionCiLog`, ADR-119 §8): staff only, like everything here.
 *
 * Grading starts at a repository's definitive freeze (`409 not_frozen`).
 * STAFF ONLY (N-SEC-20): the routes load the project (and repository)
 * through `staffAccess`, every write also behind `requireCourseRole`
 * (invariant 6); nothing here is a student's view.
 */
import { desc, eq, inArray, sql } from "drizzle-orm";

import type {
  CriteriaTableRow as TableRowContract,
  CriterionCiLog,
  CriterionGradeWrite,
  ProjectGradingRepo,
  ProjectGradingView,
  ProjectRepoCriteria,
  ProjectValidated,
} from "@quiz/contracts";
import { awardedRange, criteriaTable, currentCriterionRows, type CriteriaTableRow, type ParsedCriteria } from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { projectCiResults, projectCriteria, projectEvidence, projectGroups, users } from "../../db/schema.js";
import { notFoundError } from "../http.js";
import { criteriaStandings, type CriteriaStanding, validateProposals, writeCriterionGrades } from "./criterionGrades.js";
import { isLive } from "./deadline.js";
import { ProjectError } from "./errors.js";
import { studentRepos, type RepoRow } from "./repos.js";
import type { ProjectRow } from "./views.js";

/** The project's snapshot; `409 not_criteria` off the `criteria` mode. */
async function snapshotOf(db: Db, project: ProjectRow): Promise<ParsedCriteria> {
  const [row] = await db.select({ criteria: projectCriteria.criteria }).from(projectCriteria).where(eq(projectCriteria.projectId, project.id));
  if (project.gradingMode !== "criteria" || !row) throw new ProjectError("not_criteria", "The project is not graded by criteria");
  return row.criteria;
}

/** The repositories the screen grades: every live student or group repository (a staff test repository excepted, ADR-077). */
async function gradedRepos(db: Db, project: ProjectRow): Promise<RepoRow[]> {
  return (await studentRepos(db, project)).filter((repo) => isLive(repo, project));
}

type EvidenceStep = (typeof projectEvidence.$inferSelect)["build"];
type EvidenceSummary = NonNullable<ProjectRepoCriteria["evidence"]>;

/**
 * The summary of the last evidence of each of `repoIds`, by repository, in
 * one read: its status, commits, cases passed and the steps' exit codes —
 * never a file nor an output.
 */
async function evidenceSummaries(db: Db, repoIds: readonly string[]): Promise<Map<string, EvidenceSummary>> {
  if (repoIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([projectEvidence.repoId], {
      repoId: projectEvidence.repoId,
      status: projectEvidence.status,
      reason: projectEvidence.reason,
      targetSha: projectEvidence.targetSha,
      distributionSha: projectEvidence.distributionSha,
      cases: projectEvidence.cases,
      build: projectEvidence.build,
      test: projectEvidence.test,
      createdAt: projectEvidence.createdAt,
    })
    .from(projectEvidence)
    .where(inArray(projectEvidence.repoId, [...repoIds]))
    .orderBy(projectEvidence.repoId, desc(projectEvidence.createdAt));
  const step = (s: EvidenceStep) => (s ? { exitCode: s.exitCode, timedOut: s.timedOut } : null);
  return new Map(
    rows.map((last) => [
      last.repoId,
      {
        status: last.status,
        reason: last.reason,
        targetSha: last.targetSha,
        distributionSha: last.distributionSha,
        casesPassed: (last.cases ?? []).filter((c) => c.passed).length,
        casesTotal: (last.cases ?? []).length,
        build: step(last.build),
        test: step(last.test),
        createdAt: last.createdAt.toISOString(),
      },
    ]),
  );
}

/** The current row of each criterion set by a CI pass (ADR-119 §6): its pass, by criterion. */
const ciPasses = (standing: CriteriaStanding) =>
  [...currentCriterionRows(standing.rows).values()].filter((row) => row.source === "auto" && row.passId !== null && row.reason === null);

/**
 * The criteria, by repository, whose current row's CI pass stored a
 * non-empty log for them, in one read that never loads a log: what the
 * table marks `ciLog` (the log itself is {@link criterionCiLog}'s).
 */
async function loggedCriteria(db: Db, standings: ReadonlyMap<string, CriteriaStanding>): Promise<Map<string, Set<string>>> {
  const rows = [...standings].flatMap(([repoId, standing]) => ciPasses(standing).map((row) => ({ repoId, criterionId: row.criterionId, passId: row.passId! })));
  const logged = new Map<string, Set<string>>();
  if (rows.length === 0) return logged;
  const passes = await db
    .select({
      passId: projectCiResults.passId,
      criteria: sql<string[]>`array(select key from jsonb_each(${projectCiResults.results}->'criteria') where coalesce(value->>'log', '') <> '')`,
    })
    .from(projectCiResults)
    .where(inArray(projectCiResults.passId, [...new Set(rows.map((r) => r.passId))]));
  const byPass = new Map(passes.map((p) => [p.passId, new Set(p.criteria)]));
  for (const { repoId, criterionId, passId } of rows) {
    if (!byPass.get(passId)?.has(criterionId)) continue;
    logged.set(repoId, (logged.get(repoId) ?? new Set()).add(criterionId));
  }
  return logged;
}

/** The screen's entry of each of `repos` (of a project graded by criteria), named, in the order of their names. */
async function gradingRepos(db: Db, project: ProjectRow, repos: readonly RepoRow[]): Promise<ProjectGradingRepo[]> {
  if (repos.length === 0) return [];
  const groupIds = repos.flatMap((r) => (r.groupId === null ? [] : [r.groupId]));
  const userIds = repos.filter((r) => r.groupId === null).map((r) => r.userId);
  const [standings, evidence, groups, people] = await Promise.all([
    criteriaStandings(db, repos),
    evidenceSummaries(db, repos.map((r) => r.id)),
    groupIds.length === 0
      ? []
      : db.select({ id: projectGroups.id, name: projectGroups.name }).from(projectGroups).where(inArray(projectGroups.id, groupIds)),
    userIds.length === 0
      ? []
      : db.select({ id: users.id, given: users.givenName, family: users.familyName }).from(users).where(inArray(users.id, userIds)),
  ]);
  const logged = await loggedCriteria(db, standings);
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const personName = new Map(people.map((p) => [p.id, `${p.family} ${p.given}`.trim()]));
  const released = project.releasedAt !== null;
  return repos
    .flatMap((repo) => {
      const standing = standings.get(repo.id);
      if (!standing) return [];
      const own = logged.get(repo.id);
      const table = criteriaTable(standing.snapshot, standing.rows, { audience: "staff", frozen: repo.frozenAt !== null, released });
      return [
        {
          id: repo.id,
          label: (repo.groupId === null ? personName.get(repo.userId) : groupName.get(repo.groupId)) || (repo.fullName ?? repo.id),
          group: repo.groupId !== null,
          frozen: repo.frozenAt !== null,
          validation: standing.validation,
          table: table.map((row): TableRowContract => (own?.has(row.criterionId) ? { ...row, ciLog: true } : row)),
          evidence: evidence.get(repo.id) ?? null,
          total: standing.score,
        },
      ];
    })
    .sort((a, b) => a.label.localeCompare(b.label, "fr"));
}

/**
 * One repository's entry: the grading screen's after a write, and `GET
 * …/repos/:rid/criteria` (§6) — the staff's table, never the evidence's
 * files. `409 not_criteria` off the mode.
 */
export async function gradingRepo(db: Db, project: ProjectRow, repo: RepoRow): Promise<ProjectGradingRepo> {
  await snapshotOf(db, project);
  const [entry] = await gradingRepos(db, project, [repo]);
  return entry!;
}

/** `GET /app/api/projects/:id/grading`: every repository the screen grades. */
export async function gradingView(db: Db, project: ProjectRow): Promise<ProjectGradingView> {
  await snapshotOf(db, project);
  return {
    project: { id: project.id, classroomId: project.classroomId, name: project.name, deadlineAt: iso(project.deadlineAt) },
    repos: await gradingRepos(db, project, await gradedRepos(db, project)),
  };
}

/**
 * `GET …/repos/:rid/criteria/:criterionId/ci-log` (ADR-119 §8): the log the
 * CI pass that set the criterion's current row stored for it, its tail;
 * null when no CI pass set it or the run wrote none. A 404 for a criterion
 * the snapshot lacks, `409 not_criteria` off the mode. Staff only.
 */
export async function criterionCiLog(db: Db, project: ProjectRow, repo: RepoRow, criterionId: string): Promise<CriterionCiLog> {
  const snapshot = await snapshotOf(db, project);
  if (!snapshot.leaves.some((l) => l.id === criterionId)) throw notFoundError("criterion");
  const standing = (await criteriaStandings(db, [repo])).get(repo.id);
  const row = standing ? ciPasses(standing).find((r) => r.criterionId === criterionId) : undefined;
  if (!row) return { log: null };
  const [stored] = await db
    .select({ log: sql<string | null>`${projectCiResults.results}->'criteria'->${criterionId}->>'log'` })
    .from(projectCiResults)
    .where(eq(projectCiResults.passId, row.passId!));
  return { log: stored?.log || null };
}

/**
 * `PUT …/repos/:rid/criteria/:criterionId`: the teacher's points, a
 * `manual` row still `proposed` (a teacher's edit is not a validation,
 * ADR-106 §8), its rationale the one given or, when none is, the one of
 * the row it replaces. `404` for a criterion the snapshot lacks, `422
 * points_out_of_range` (with the range) outside `awardedRange`. Audited
 * `project_repo.criterion_graded`.
 */
export async function gradeCriterion(
  db: Db,
  project: ProjectRow,
  repo: RepoRow,
  criterionId: string,
  body: CriterionGradeWrite,
  actor: AuditActor,
  userId: string,
  now: Date,
): Promise<ProjectGradingRepo> {
  const snapshot = await snapshotOf(db, project);
  const leaf = snapshot.leaves.find((l) => l.id === criterionId);
  if (!leaf) throw notFoundError("criterion");
  if (repo.frozenAt === null) throw new ProjectError("not_frozen", "A criterion is graded once the repository's deadline and grace have passed");
  const [min, max] = awardedRange(leaf);
  if (body.points < min || body.points > max) {
    throw new ProjectError("points_out_of_range", `The points of this criterion lie within [${min}, ${max}]`, { min, max });
  }
  const standing = (await criteriaStandings(db, [repo])).get(repo.id)!;
  const before = currentCriterionRows(standing.rows).get(criterionId) ?? null;
  await writeCriterionGrades(
    db,
    repo.id,
    [
      {
        criterionId,
        points: body.points,
        max: leaf.maxPoints,
        source: "manual",
        state: "proposed",
        rationale: body.rationale ?? before?.rationale ?? null,
        reason: null,
        passId: null,
        createdBy: userId,
      },
    ],
    now,
  );
  await audit(db, {
    ...actor,
    action: "project_repo.criterion_graded",
    subjectType: "project_repo",
    subjectId: repo.id,
    payload: { projectId: project.id, criterionId, points: body.points, before: before?.points ?? null },
    at: now,
  });
  return gradingRepo(db, project, repo);
}

/** Validates `repoIds` as one (`validateProposals`) and audits each repository that had something to validate. */
async function validate(db: Db, project: ProjectRow, repoIds: readonly string[], bulk: boolean, actor: AuditActor, now: Date): Promise<number> {
  const counts = await validateProposals(db, repoIds, await snapshotOf(db, project), now);
  let validated = 0;
  for (const [repoId, criteria] of counts) {
    if (criteria === 0) continue;
    validated += 1;
    await audit(db, {
      ...actor,
      action: "project_repo.validated",
      subjectType: "project_repo",
      subjectId: repoId,
      payload: { projectId: project.id, criteria, bulk },
      at: now,
    });
  }
  return validated;
}

/**
 * `POST …/repos/:rid/validate`: every current proposal of the repository
 * validated; `409 criteria_incomplete` while a criterion has no row, `409
 * not_frozen` before its definitive freeze. Idempotent: a validated
 * repository writes and audits nothing.
 */
export async function validateRepo(db: Db, project: ProjectRow, repo: RepoRow, actor: AuditActor, now: Date): Promise<ProjectGradingRepo> {
  await validate(db, project, [repo.id], false, actor, now);
  return gradingRepo(db, project, repo);
}

/**
 * `POST …/validate` (*Validate the rest as proposed*): every live student
 * or group repository frozen for good, in ONE transaction — refused as a
 * whole (`409 criteria_incomplete`, every repository and criterion named)
 * while a criterion of one has no row; `409 not_frozen` when none is
 * frozen. Answers how many it validated.
 */
export async function validateProject(db: Db, project: ProjectRow, actor: AuditActor, now: Date): Promise<ProjectValidated> {
  await snapshotOf(db, project);
  const repos = (await gradedRepos(db, project)).filter((repo) => repo.frozenAt !== null);
  if (repos.length === 0) throw new ProjectError("not_frozen", "No repository is frozen for good");
  return { validated: await validate(db, project, repos.map((r) => r.id), true, actor, now) };
}

/** The domain's table line and the contract's are one shape: either drifting breaks the build. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameTableRow: Same<CriteriaTableRow, TableRowContract> = true;
void sameTableRow;
