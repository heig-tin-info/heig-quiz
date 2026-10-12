/**
 * A Regrade by the staff (ADR-106 §4), and the staff's criteria table of
 * one repository (§6).
 *
 * **Regrade**, of the project or of one repository: a new pass over the
 * repositories frozen for good — each one's evidence (an `ok` evidence of
 * the same target and distribution commits reused, `collectEvidence`),
 * then its review (`reviewPass.ts`), which proposes again the llm criteria
 * no one holds; the evidence job proposes the automatic ones. Neither ever
 * supersedes a validated row nor a teacher's. At most
 * {@link PROJECT_REGRADES_PER_DAY} a day per project, the project's and a
 * repository's counting one each, on the audit log's entries and the
 * server's day in the school's zone (ADR-058 L2 (b)): two pressed at the
 * same instant may both pass, the cap bounds a day, not a race. The routes
 * hold the project loader and the course role (invariant 6).
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { CriteriaTableRow as TableRowContract, ProjectRegradeAccepted, ProjectRepoCriteria } from "@quiz/contracts";
import { criteriaTable, PROJECT_REGRADES_PER_DAY, SCHOOL_TIME_ZONE, type CriteriaTableRow } from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { auditLog, projectCriteria, projectCriterionGrades, projectEvidence, projectRepos, projects } from "../../db/schema.js";
import { PROJECT_EVIDENCE_QUEUE } from "../../jobs.js";
import { isLive, LIVE } from "./deadline.js";
import { ProjectError } from "./errors.js";
import type { EvidenceJob } from "./evidence.js";
import type { RepoRow } from "./repos.js";
import { runEvidencePass } from "./reviewPass.js";
import type { ProjectRow } from "./views.js";

/** The project's regrades today (the server's day, in the school's zone). */
async function regradesToday(db: Db, projectId: string, now: Date): Promise<number> {
  const [today] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(
      and(
        inArray(auditLog.action, ["project.regrade", "project_repo.regrade"]),
        eq(auditLog.subjectType, "project"),
        eq(auditLog.subjectId, projectId),
        sql`${auditLog.createdAt} >= date_trunc('day', ${now.toISOString()}::timestamptz, ${SCHOOL_TIME_ZONE})`,
      ),
    );
  return today?.n ?? 0;
}

/**
 * `POST …/regrade` (`repo` null) and `POST …/repos/:rid/regrade`: refused
 * with `409 not_criteria` off the `criteria` mode, `409 not_frozen` when
 * the repository (or every repository) is not frozen for good, `429
 * regrade_limit` past the day's three; audited, then each repository's
 * evidence job sent (run here without a queue). The repositories sent: one
 * model call each, what the confirmation priced.
 */
export async function regrade(
  app: FastifyInstance,
  config: AppConfig,
  project: ProjectRow,
  repo: RepoRow | null,
  actor: AuditActor,
  now: Date,
): Promise<ProjectRegradeAccepted> {
  const db = app.db;
  const [snapshot] = await db.select().from(projectCriteria).where(eq(projectCriteria.projectId, project.id));
  if (project.gradingMode !== "criteria" || !snapshot) throw new ProjectError("not_criteria", "The project is not graded by criteria");
  const repos =
    repo === null
      ? await db
          .select({ id: projectRepos.id })
          .from(projectRepos)
          .innerJoin(projects, eq(projects.id, projectRepos.projectId))
          .where(and(eq(projectRepos.projectId, project.id), LIVE, isNotNull(projectRepos.frozenAt)))
      : isLive(repo, project) && repo.frozenAt !== null
        ? [{ id: repo.id }]
        : [];
  if (repos.length === 0) throw new ProjectError("not_frozen", "No repository is frozen for good");
  if ((await regradesToday(db, project.id, now)) >= PROJECT_REGRADES_PER_DAY) {
    throw new ProjectError("regrade_limit", "This project was regraded as often as a day allows: try again tomorrow");
  }
  const passId = randomUUID();
  // Both on the project, what the day's cap counts; the repository's in the payload.
  await audit(db, {
    ...actor,
    action: repo === null ? "project.regrade" : "project_repo.regrade",
    subjectType: "project",
    subjectId: project.id,
    payload: repo === null ? { passId, repos: repos.length } : { passId, repoId: repo.id },
    at: now,
  });
  for (const { id } of repos) {
    const job: EvidenceJob = { repoId: id, passId };
    if (app.boss) await app.boss.send(PROJECT_EVIDENCE_QUEUE, job);
    else await runEvidencePass(app, config, job).catch((err: unknown) => app.log.error({ err, repo: id }, "regrade: evidence failed"));
  }
  return { repos: repos.length };
}

/**
 * `GET …/repos/:rid/criteria` (§6): the staff's table of the repository —
 * every criterion of the snapshot with its current row, source, rationale
 * and reason — and its last evidence's summary, never its files.
 */
export async function repoCriteria(db: Db, project: ProjectRow, repo: RepoRow): Promise<ProjectRepoCriteria> {
  const [snapshot] = await db.select().from(projectCriteria).where(eq(projectCriteria.projectId, project.id));
  const rows = await db.select().from(projectCriterionGrades).where(eq(projectCriterionGrades.repoId, repo.id));
  const table = snapshot
    ? criteriaTable(snapshot.criteria, rows, { audience: "staff", frozen: repo.frozenAt !== null, released: project.releasedAt !== null })
    : [];
  const [last] = await db
    .select()
    .from(projectEvidence)
    .where(eq(projectEvidence.repoId, repo.id))
    .orderBy(desc(projectEvidence.createdAt))
    .limit(1);
  const step = (s: EvidenceStep) => (s ? { exitCode: s.exitCode, timedOut: s.timedOut } : null);
  return {
    table,
    evidence: last
      ? {
          status: last.status,
          reason: last.reason,
          targetSha: last.targetSha,
          distributionSha: last.distributionSha,
          casesPassed: (last.cases ?? []).filter((c) => c.passed).length,
          casesTotal: (last.cases ?? []).length,
          build: step(last.build),
          test: step(last.test),
          createdAt: last.createdAt.toISOString(),
        }
      : null,
  };
}

type EvidenceStep = (typeof projectEvidence.$inferSelect)["build"];

/** The domain's table line and the contract's are one shape: either drifting breaks the build. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameTableRow: Same<CriteriaTableRow, TableRowContract> = true;
void sameTableRow;
