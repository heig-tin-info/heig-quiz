/**
 * A Regrade by the staff (ADR-106 §4). The staff's criteria table of one
 * repository is `criteriaGrading.ts`'s.
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
import { and, eq, isNotNull, sql } from "drizzle-orm";

import type { ProjectRegradeAccepted } from "@quiz/contracts";
import { PROJECT_REGRADES_PER_DAY, SCHOOL_TIME_ZONE } from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { auditLog, projectCriteria, projectRepos, projects } from "../../db/schema.js";
import { PROJECT_EVIDENCE_QUEUE } from "../../jobs.js";
import { isLive, LIVE } from "./deadline.js";
import { ProjectError } from "./errors.js";
import type { EvidenceJob } from "./evidence.js";
import type { RepoRow } from "./repos.js";
import { runEvidencePass } from "./reviewPass.js";
import type { ProjectRow } from "./views.js";

type RegradeAction = "project.regrade" | "project_repo.regrade";

/**
 * The regrades today (the server's day, in the school's zone) of this action:
 * the project's own, or one repository's — each capped apart (ADR-106 §4 as
 * amended 2026-10-12: fixing one repository at a time never spends the
 * project's).
 */
async function regradesToday(db: Db, projectId: string, action: RegradeAction, repoId: string | null, now: Date): Promise<number> {
  const [today] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, action),
        eq(auditLog.subjectType, "project"),
        eq(auditLog.subjectId, projectId),
        repoId === null ? undefined : sql`${auditLog.payload}->>'repoId' = ${repoId}`,
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
  const action: RegradeAction = repo === null ? "project.regrade" : "project_repo.regrade";
  if ((await regradesToday(db, project.id, action, repo?.id ?? null, now)) >= PROJECT_REGRADES_PER_DAY) {
    throw new ProjectError("regrade_limit", "Regraded as often as a day allows: try again tomorrow");
  }
  const passId = randomUUID();
  // Both on the project; the repository's in the payload, which its own day's cap counts.
  await audit(db, {
    ...actor,
    action,
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
