/**
 * An `online_seb` project's repositories opened to their students,
 * read-only, once the lab is over (ADR-145, amending ADR-047 §2).
 *
 * - **The fact** is `projects.repos_opened_at`, the server's clock: set by
 *   the course owner's open (`reposOpeningRefusal` of `@quiz/domain`),
 *   cleared by their close (allowed whenever they are open, an archived
 *   project's included); either is a no-op when the fact already says so
 *   ({@link setReposOpen}). Neither calls GitHub: in ONE transaction they
 *   write the fact, audit it, and claim the project's `repos_access_job_at`
 *   lease when no live job holds it; the job is sent after the commit.
 * - **The permission** of every invitation reads the fact (`inviteAccount`,
 *   `access.ts`): `pull` on a repository the opening opens (`openingOf`),
 *   nothing otherwise — an Accept, a resend, the reconciliation and this
 *   job alike.
 * - **The job** ({@link runReposAccessJob}, `project.repos_access`) is the
 *   project's ONE runner of the opening on GitHub, under its lease: it
 *   brings GitHub to the fact it reads — while open, the seat of each
 *   repository the opening opens and nobody is let into is invited with
 *   `pull` (`inviteAccount`); while closed, every recorded live grant of the
 *   project's repositories is revoked (`revokeGrants`, a pending invitation
 *   cancelled first, the repository back to `none` once nobody is left) —
 *   never `revokeEnrollmentAccess`, which would cut the student's
 *   repositories of every other project. Each step reads the fact again and
 *   the pass stops when it moved; the job then runs a pass for the new
 *   fact, and gives the lease back only in a write that finds the fact it
 *   converged to ({@link heldLease}'s `releaseIf`). So whatever the
 *   interleaving of the owner's writes, the last pass leaves GitHub and
 *   `invitation_status` as the fact says. A repository archived as its
 *   lock, a seat without a linked or with a stale account, a seat gone from
 *   the roster: skipped, never fatal for the others. A failure backdates the
 *   lease, a crash leaves it; the ticker claims either once expired
 *   ({@link claimReposAccessWork}).
 *
 * STAFF ONLY: the routes load the project under `staffAccess`, the owner's
 * role checked by their loader (invariant 6). The student reads the
 * outcome through the project's student view alone (N-SEC-20).
 */
import type { FastifyInstance } from "fastify";
import type { Octokit } from "octokit";
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";

import type { ProjectReposAccess } from "@quiz/contracts";
import { openingOf, reposOpeningRefusal, type ReposOpeningRefusalCode } from "@quiz/domain";

import { audit, SYSTEM_ACTOR, type AuditActor } from "../../audit.js";
import { isoOrNull } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { classrooms, projectRepoAccess, projectRepos, projects } from "../../db/schema.js";
import { installationClient } from "../../github/app.js";
import { PROJECT_REPOS_ACCESS_QUEUE } from "../../jobs.js";
import { projectInstallation } from "../github/service.js";
import { notFoundError } from "../http.js";
import { followInvitation, inviteAccount, notRecorded, revokeGrants } from "./access.js";
import { reposHoldingWork } from "./commits.js";
import { isLive, releaseCounts } from "./deadline.js";
import { ProjectError } from "./errors.js";
import { repoMembers } from "./groupRepos.js";
import { claimLeases, forEachLimit, heldLease, LEASE_MS, REPO_CONCURRENCY, type ProjectJob } from "./lease.js";
import { studentRepos, type RepoRow } from "./repos.js";
import type { ProjectRow } from "./views.js";

/** What the opening reads beside the project and its repositories: its classroom's archive, the course's other sittings on its source. */
export async function openingContext(db: Db | Tx, project: ProjectRow): Promise<{ classroomArchived: boolean; sameSource: string[] }> {
  const [room] = await db
    .select({ courseId: classrooms.courseId, archivedAt: classrooms.archivedAt })
    .from(classrooms)
    .where(eq(classrooms.id, project.classroomId));
  // A sitting still to come on the same subject (ADR-145 §5): the course's other projects on this source, not locked yet.
  const others = await db
    .select({ name: projects.name })
    .from(projects)
    .innerJoin(classrooms, eq(classrooms.id, projects.classroomId))
    .where(
      and(
        eq(classrooms.courseId, room!.courseId),
        ne(projects.id, project.id),
        eq(projects.sourceRepoId, project.sourceRepoId),
        isNull(projects.archivedAt),
        ne(projects.state, "locked"),
      ),
    )
    .orderBy(projects.name);
  return { classroomArchived: room!.archivedAt !== null, sameSource: others.map((p) => p.name) };
}

/** What {@link reposOpening} reads, from data the caller holds. */
export interface OpeningInput {
  project: ProjectRow;
  /** The project's student repositories (`studentRepos`): what is counted, as the release counts them (ADR-077). */
  repos: readonly RepoRow[];
  counts: { live: number; frozen: number };
  /** The repositories holding their student's work (`holdsWork`). */
  work: ReadonlySet<string>;
  classroomArchived: boolean;
  sameSource: string[];
}

/** The opening as the staff read it (`ProjectReposAccess`) and whether the owner may open now (`reposOpeningRefusal`). */
export function reposOpening(i: OpeningInput): { view: ProjectReposAccess; refusal: ReposOpeningRefusalCode | null } {
  const openings = i.repos.filter((r) => isLive(r, i.project)).map((r) => openingOf({ ...r, work: i.work.has(r.id) }));
  const openable = openings.filter((o) => o === "open").length;
  const refusal = reposOpeningRefusal({
    workMode: i.project.workMode,
    gradingMode: i.project.gradingMode,
    projectArchived: i.project.archivedAt !== null,
    classroomArchived: i.classroomArchived,
    released: i.project.releasedAt !== null,
    ...i.counts,
    openable,
  });
  return {
    refusal,
    view: {
      openedAt: isoOrNull(i.project.reposOpenedAt),
      openable,
      nothingToOpen: openings.filter((o) => o === "nothing").length,
      sameSource: i.sameSource,
    },
  };
}

/**
 * `POST /app/api/projects/:id/repos/open` (`open`) and `…/repos/close`
 * (ADR-145 §1, §6), the course owner's. In one transaction on the
 * project's row: the opening refused by `reposOpeningRefusal` (`409` with
 * its code); the fact written and audited — `project.repos_opened`,
 * `project.repos_closed` — unless it already says so (the close's row lock
 * waits for an invitation recording its grant, `inviteAccount`); the lease
 * claimed when no live job holds it, the job sent after the commit — a job
 * holding it finds the new fact at its next step.
 */
export async function setReposOpen(app: FastifyInstance, config: AppConfig, projectId: string, open: boolean, actor: AuditActor, now: Date): Promise<void> {
  const job = await app.db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!project) throw notFoundError("project");
    const changed = open !== (project.reposOpenedAt !== null);
    if (changed && open) {
      const repos = await studentRepos(tx, project);
      const [context, work] = await Promise.all([openingContext(tx, project), reposHoldingWork(tx, project, repos)]);
      const { refusal, view } = reposOpening({ project, repos, counts: releaseCounts(project, repos), work, ...context });
      if (refusal) throw new ProjectError(refusal, "The repositories cannot be opened now");
      await audit(tx, { ...actor, action: "project.repos_opened", subjectType: "project", subjectId: projectId, payload: { openable: view.openable, nothingToOpen: view.nothingToOpen } });
    } else if (changed) {
      await audit(tx, { ...actor, action: "project.repos_closed", subjectType: "project", subjectId: projectId, payload: { openedAt: project.reposOpenedAt!.toISOString() } });
    }
    const claim = project.reposAccessJobAt === null || project.reposAccessJobAt.getTime() < now.getTime() - LEASE_MS;
    if (!changed && !claim) return null;
    await tx
      .update(projects)
      .set({ ...(changed ? { reposOpenedAt: open ? now : null } : {}), ...(claim ? { reposAccessJobAt: now } : {}) })
      .where(eq(projects.id, projectId));
    return claim ? ({ projectId, lease: now.toISOString() } satisfies ProjectJob) : null;
  });
  if (job === null) return;
  if (app.boss) {
    await app.boss.send(PROJECT_REPOS_ACCESS_QUEUE, job);
    return;
  }
  // Without a queue, in the request, as the deadline's staff actions run theirs.
  await runReposAccessJob(app, config, job).catch((err: unknown) => app.log.error({ err, project: projectId }, "project repos access job failed"));
}

/** The ticker's claim: a lease a failed job backdated, or a crashed one left, once expired (`claimLeases`). */
export function claimReposAccessWork(db: Db, now: Date): Promise<ProjectJob[]> {
  return claimLeases(db, "reposAccessJobAt", now, sql`${projects.reposAccessJobAt} IS NOT NULL`);
}

type Lease = ReturnType<typeof heldLease>;

/**
 * `items` through `step`, four at a time, each step only while the opening
 * still is `fact` (read again before it) and the lease held, the lease
 * renewed after each; the steps that threw, counted.
 */
async function converge<T>(app: FastifyInstance, project: ProjectRow, fact: Date | null, lease: Lease, items: readonly T[], step: (item: T) => Promise<void>): Promise<number> {
  let moved = false;
  let failed = 0;
  await forEachLimit(
    items,
    REPO_CONCURRENCY,
    async (item) => {
      const [row] = await app.db.select({ at: projects.reposOpenedAt }).from(projects).where(eq(projects.id, project.id));
      if ((row?.at?.getTime() ?? null) !== (fact?.getTime() ?? null)) {
        moved = true;
        return;
      }
      try {
        await step(item);
      } catch (err) {
        app.log.error({ err, project: project.id }, "project repos access: a step failed");
        failed += 1;
      }
      await lease.renew();
    },
    () => moved || lease.lost(),
  );
  return failed;
}

/**
 * Open: the seat of every repository the opening opens and nobody is let
 * into — its state `none`, or no live grant (a revocation crashed before
 * its state) — invited with `pull`. Archived on GitHub as its lock (H8), a
 * repository takes no new collaborator: skipped, its state stays `none`.
 */
async function invitePass(app: FastifyInstance, octokit: Octokit, project: ProjectRow, lease: Lease): Promise<number> {
  const db = app.db;
  const frozen = await db
    .select()
    .from(projectRepos)
    .where(and(eq(projectRepos.projectId, project.id), isNull(projectRepos.groupId), isNotNull(projectRepos.frozenAt)));
  const live = frozen.filter((r) => isLive(r, project) && r.archivedAt === null);
  const [work, granted] = await Promise.all([
    reposHoldingWork(db, project, live),
    db
      .select({ repoId: projectRepoAccess.repoId })
      .from(projectRepoAccess)
      .innerJoin(projectRepos, eq(projectRepos.id, projectRepoAccess.repoId))
      .where(and(eq(projectRepos.projectId, project.id), isNull(projectRepoAccess.revokedAt), isNull(projectRepoAccess.revokingAt))),
  ]);
  const inside = new Set(granted.map((g) => g.repoId));
  const targets = live.filter(
    (r) => openingOf({ ...r, work: work.has(r.id) }) === "open" && (r.invitationStatus === "none" || !inside.has(r.id)),
  );
  return converge(app, project, project.reposOpenedAt, lease, targets, async (repo) => {
    for (const member of await repoMembers(db, repo, project.classroomId)) {
      if (member.account === null) continue;
      const ctx = { actor: SYSTEM_ACTOR, log: app.log, now: app.clock.now(), via: "repos.open", failure: "invite_failed" } as const;
      const invited = await inviteAccount(db, octokit, repo, { ...member, account: member.account }, ctx).catch((err: unknown) => {
        // A stale account (the student relinks, then resends), or the opening that no longer holds: skipped. GitHub failing fails the step.
        if (!(err instanceof ProjectError) || err.code === "invite_failed") throw err;
        app.log.warn({ code: err.code, repo: repo.fullName }, "project repos access: an invitation was skipped");
        return null;
      });
      // Taken back (`gone`), nothing to follow.
      if (invited !== null && !notRecorded(invited)) await followInvitation(db, repo, invited.invitation);
    }
  });
}

/** Closed: every recorded live grant of the project's repositories revoked, one at a time. */
async function revokePass(app: FastifyInstance, octokit: Octokit, project: ProjectRow, lease: Lease): Promise<number> {
  const live = await app.db
    .select({ grant: projectRepoAccess, repo: projectRepos })
    .from(projectRepoAccess)
    .innerJoin(projectRepos, eq(projectRepos.id, projectRepoAccess.repoId))
    .where(and(eq(projectRepos.projectId, project.id), isNull(projectRepoAccess.revokedAt)));
  return converge(app, project, null, lease, live, ({ grant, repo }) =>
    revokeGrants(app.db, [{ grant, repo, client: octokit }], grant.enrollmentId, {
      actor: SYSTEM_ACTOR,
      log: app.log,
      now: app.clock.now(),
      via: "repos.close",
    }),
  );
}

/** The `project.repos_access` job (ADR-145): passes until GitHub matches the fact the lease is given back on. */
export async function runReposAccessJob(app: FastifyInstance, config: AppConfig, job: ProjectJob): Promise<void> {
  const db = app.db;
  const [start] = await db.select().from(projects).where(eq(projects.id, job.projectId));
  if (!start || start.reposAccessJobAt?.toISOString() !== job.lease) return;
  // Without the App on the organization: the lease kept, the ticker claims it again once expired.
  const org = await projectInstallation(db, start.orgId);
  if (!org) return;
  const { octokit } = await installationClient(config, org.installationId);
  const lease = heldLease(app, "reposAccessJobAt", start.id, start.reposAccessJobAt);
  for (;;) {
    const [project] = await db.select().from(projects).where(eq(projects.id, start.id));
    const fact = project!.reposOpenedAt;
    const failed = await (fact === null ? revokePass : invitePass)(app, octokit, project!, lease);
    if (lease.lost()) return;
    if (failed > 0) {
      await lease.expireSoon();
      throw new Error(`project repos access incomplete: ${failed} steps failed`);
    }
    if (await lease.releaseIf(fact === null ? isNull(projects.reposOpenedAt) : eq(projects.reposOpenedAt, fact))) return;
    // The fact moved during the pass: another pass, for the new one.
    await lease.renew();
    if (lease.lost()) return;
  }
}
