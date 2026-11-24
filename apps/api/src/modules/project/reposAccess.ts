/**
 * An `online_seb` project's repositories opened to their students,
 * read-only, once the lab is over (ADR-145, amending ADR-047 §2).
 *
 * - **The fact** is `projects.repos_opened_at`, the server's clock: written
 *   by the course owner's open ({@link openRepos}, `reposOpeningRefusal` of
 *   `@quiz/domain`) and cleared by their close ({@link closeRepos}, allowed
 *   whenever they are open, an archived project's included). Neither calls
 *   GitHub: each audits, takes the project's `repos_access_job_at` lease
 *   over and sends the job, and answers at once.
 * - **The permission** of every invitation reads the fact
 *   (`invitationPermission`, `access.ts`): `pull` on a repository that may
 *   be opened — individual, live, frozen for good, holding its student's
 *   work —, nothing otherwise. An Accept, a resend, the reconciliation and
 *   this job alike.
 * - **The job** ({@link runReposAccessJob}, `project.repos_access`)
 *   converges GitHub to the fact, in the leased frame of `lease.ts`: while
 *   open, each openable repository nobody is invited on (`invitation_status`
 *   `none`) has its seat invited with `pull` (`inviteAccount`, which reads
 *   the fact again, and again under the project's lock as it records the
 *   grant); while closed, every recorded live grant of the project's
 *   repositories is revoked, one repository at a time (`revokeGrants`, a
 *   pending invitation cancelled first, the repository's state back to
 *   `none` once nobody is left) — never `revokeEnrollmentAccess`, which
 *   would cut the student's repositories of every other project. A
 *   repository archived on GitHub as its lock, a seat without a linked or
 *   with a stale account, a seat gone from the roster: skipped, never fatal
 *   for the others. The owner's next write takes the lease over: the job
 *   holding it stops at its next renewal. A failure backdates the lease, a
 *   crash leaves it to expire; the ticker claims either ({@link claimReposAccessWork}).
 *
 * STAFF ONLY: the routes load the project under `staffAccess`, the owner's
 * role checked by their loader (invariant 6). The student reads the
 * outcome through the project's student view alone (N-SEC-20).
 */
import type { FastifyInstance } from "fastify";
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";

import type { ProjectReposAccess } from "@quiz/contracts";
import { nothingToOpen, repoOpenable, reposOpeningRefusal, type OpenableRepo } from "@quiz/domain";

import { audit, SYSTEM_ACTOR, type AuditActor } from "../../audit.js";
import { isoOrNull } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { classrooms, projectRepoAccess, projectRepos, projects } from "../../db/schema.js";
import { PROJECT_REPOS_ACCESS_QUEUE } from "../../jobs.js";
import { notFoundError } from "../http.js";
import { followInvitation, inviteAccount, notRecorded, revokeGrants, type GrantRow } from "./access.js";
import { reposHoldingWork } from "./commits.js";
import { isLive, releaseCounts } from "./deadline.js";
import { ProjectError } from "./errors.js";
import { repoMembers } from "./groupRepos.js";
import { claimLeases, runLeased, type ProjectJob } from "./lease.js";
import { studentRepos, type RepoRow } from "./repos.js";
import type { ProjectRow } from "./views.js";

/** Each repository as the opening reads it ({@link OpenableRepo}): `work`, from the student's receipts. */
export async function openableRepos(db: Db | Tx, project: ProjectRow, repos: readonly RepoRow[]): Promise<Map<string, OpenableRepo>> {
  const work = await reposHoldingWork(db, project, repos);
  return new Map(repos.map((repo) => [repo.id, { ...repo, work: work.has(repo.id) }]));
}

/**
 * The opening of `project`'s repositories as the staff read it
 * (`ProjectReposAccess`), and whether the owner may open them now
 * (`reposOpeningRefusal`): counted over the student repositories
 * (`studentRepos`, as the release counts them — a staff seat's test
 * repository is counted nowhere, ADR-077, and opened all the same).
 */
export async function reposOpening(
  db: Db | Tx,
  project: ProjectRow,
): Promise<{ view: ProjectReposAccess; refusal: ReturnType<typeof reposOpeningRefusal> }> {
  const [room] = await db
    .select({ courseId: classrooms.courseId, archivedAt: classrooms.archivedAt })
    .from(classrooms)
    .where(eq(classrooms.id, project.classroomId));
  const repos = (await studentRepos(db, project)).filter((repo) => isLive(repo, project));
  const facts = [...(await openableRepos(db, project, repos)).values()];
  const openable = facts.filter(repoOpenable).length;
  const refusal = reposOpeningRefusal({
    workMode: project.workMode,
    gradingMode: project.gradingMode,
    projectArchived: project.archivedAt !== null,
    classroomArchived: room?.archivedAt != null,
    opened: project.reposOpenedAt !== null,
    released: project.releasedAt !== null,
    ...releaseCounts(project, repos),
    openable,
  });
  // A sitting still to come on the same subject (ADR-145 §5): the course's other projects on this source, not locked yet.
  const others = await db
    .select({ name: projects.name })
    .from(projects)
    .innerJoin(classrooms, eq(classrooms.id, projects.classroomId))
    .where(
      and(
        eq(classrooms.courseId, room?.courseId ?? ""),
        ne(projects.id, project.id),
        eq(projects.sourceRepoId, project.sourceRepoId),
        isNull(projects.archivedAt),
        ne(projects.state, "locked"),
      ),
    )
    .orderBy(projects.name);
  return {
    refusal,
    view: {
      openedAt: isoOrNull(project.reposOpenedAt),
      openable,
      nothingToOpen: facts.filter(nothingToOpen).length,
      sameSource: others.map((p) => p.name),
    },
  };
}

/**
 * The project's lease taken over and its job sent — or, without a queue,
 * run here, in the request. Taken over whatever holds it: the job of the
 * previous fact stops at its next renewal (`heldLease`).
 */
async function requestReposAccess(app: FastifyInstance, config: AppConfig, projectId: string, now: Date): Promise<void> {
  const [row] = await app.db
    .update(projects)
    .set({ reposAccessJobAt: now })
    .where(eq(projects.id, projectId))
    .returning({ lease: projects.reposAccessJobAt });
  const job: ProjectJob = { projectId, lease: row!.lease!.toISOString() };
  if (app.boss) {
    await app.boss.send(PROJECT_REPOS_ACCESS_QUEUE, job);
    return;
  }
  await runReposAccessJob(app, config, job).catch((err: unknown) =>
    app.log.error({ err, project: projectId }, "project repos access job failed"),
  );
}

/**
 * `POST /app/api/projects/:id/repos/open` (ADR-145 §1), the course owner's:
 * the fact written under the project's lock after `reposOpeningRefusal`
 * (`409` with its code), audited `project.repos_opened`, the job sent.
 */
export async function openRepos(app: FastifyInstance, config: AppConfig, projectId: string, actor: AuditActor, now: Date): Promise<ProjectReposAccess> {
  const opened = await app.db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!project) throw notFoundError("project");
    const { refusal, view } = await reposOpening(tx, project);
    if (refusal) throw new ProjectError(refusal, "The repositories cannot be opened now");
    const [row] = await tx.update(projects).set({ reposOpenedAt: now }).where(eq(projects.id, projectId)).returning();
    await audit(tx, {
      ...actor,
      action: "project.repos_opened",
      subjectType: "project",
      subjectId: projectId,
      payload: { openable: view.openable, nothingToOpen: view.nothingToOpen },
    });
    return row!;
  });
  await requestReposAccess(app, config, projectId, now);
  return (await reposOpening(app.db, opened)).view;
}

/**
 * `POST /app/api/projects/:id/repos/close` (ADR-145 §6), the course
 * owner's: the fact cleared — its row lock waits for an invitation
 * recording its grant meanwhile (`invitationPermission`) —, audited
 * `project.repos_closed`, the job sent to revoke. Closing what is not open
 * writes nothing.
 */
export async function closeRepos(app: FastifyInstance, config: AppConfig, projectId: string, actor: AuditActor, now: Date): Promise<ProjectReposAccess> {
  const closed = await app.db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!project) throw notFoundError("project");
    if (project.reposOpenedAt === null) return null;
    const [row] = await tx.update(projects).set({ reposOpenedAt: null }).where(eq(projects.id, projectId)).returning();
    await audit(tx, {
      ...actor,
      action: "project.repos_closed",
      subjectType: "project",
      subjectId: projectId,
      payload: { openedAt: project.reposOpenedAt.toISOString() },
    });
    return row!;
  });
  if (closed !== null) await requestReposAccess(app, config, projectId, now);
  const [project] = await app.db.select().from(projects).where(eq(projects.id, projectId));
  return (await reposOpening(app.db, project!)).view;
}

/** The ticker's claim: a lease a failed job backdated, or a crashed one left, once expired (`claimLeases`). */
export function claimReposAccessWork(db: Db, now: Date): Promise<ProjectJob[]> {
  return claimLeases(db, "reposAccessJobAt", now, sql`${projects.reposAccessJobAt} IS NOT NULL`);
}

/** The `project.repos_access` job (ADR-145), in the leased frame (`runLeased`): GitHub brought to the fact it reads. */
export async function runReposAccessJob(app: FastifyInstance, config: AppConfig, job: ProjectJob): Promise<void> {
  await runLeased(app, config, "reposAccessJobAt", job, "project repos access", async ({ project, octokit, each }) => {
    const db = app.db;
    const ctx = { actor: SYSTEM_ACTOR, log: app.log };
    if (project.reposOpenedAt !== null) {
      const waiting = await db
        .select()
        .from(projectRepos)
        .where(and(eq(projectRepos.projectId, project.id), eq(projectRepos.invitationStatus, "none"), isNotNull(projectRepos.frozenAt)));
      const facts = await openableRepos(db, project, waiting);
      // Archived on GitHub as its lock (H8): it takes no new collaborator — skipped, its row stays `none`.
      const targets = waiting.filter((repo) => isLive(repo, project) && repo.archivedAt === null && repoOpenable(facts.get(repo.id)!));
      await each(targets, async (repo) => {
        for (const member of await repoMembers(db, repo, project.classroomId)) {
          if (member.account === null) continue;
          const invited = await inviteAccount(db, octokit, repo, { ...member, account: member.account }, {
            ...ctx,
            now: app.clock.now(),
            via: "repos.open",
            failure: "invite_failed",
          }).catch((err: unknown) => {
            // A stale account (the student relinks, then resends), or the fact moved meanwhile: skipped. GitHub failing fails the repository.
            if (!(err instanceof ProjectError) || err.code === "invite_failed") throw err;
            app.log.warn({ code: err.code, repo: repo.fullName }, "project repos access: an invitation was skipped");
            return null;
          });
          if (invited !== null && !notRecorded(invited)) await followInvitation(db, repo, invited.invitation);
        }
      });
      return;
    }
    const live = await db
      .select({ grant: projectRepoAccess, repo: projectRepos })
      .from(projectRepoAccess)
      .innerJoin(projectRepos, eq(projectRepos.id, projectRepoAccess.repoId))
      .where(and(eq(projectRepos.projectId, project.id), isNull(projectRepoAccess.revokedAt)))
      .orderBy(projectRepoAccess.repoId, projectRepoAccess.enrollmentId);
    const byRepo = new Map<string, { repo: RepoRow; fullName: string | null; grants: GrantRow[] }>();
    for (const { grant, repo } of live) {
      const entry = byRepo.get(repo.id) ?? { repo, fullName: repo.fullName, grants: [] };
      byRepo.set(repo.id, { ...entry, grants: [...entry.grants, grant] });
    }
    await each([...byRepo.values()], async ({ repo, grants }) => {
      for (const grant of grants) {
        await revokeGrants(db, [{ grant, repo, client: octokit }], grant.enrollmentId, { ...ctx, now: app.clock.now(), via: "repos.close" });
      }
    });
  });
}
