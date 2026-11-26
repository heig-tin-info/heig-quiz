/**
 * An `online_seb` project's repositories opened to their students,
 * read-only, once the lab is over (ADR-145, amending ADR-047 §2).
 *
 * - **The fact** is `projects.repos_opened_at`, the server's clock: set by
 *   the course owner's open (`reposOpeningRefusal` of `@quiz/domain`),
 *   cleared by their close (allowed whenever they are open, an archived
 *   project's included); a write that changes nothing writes nothing — no
 *   lease, no job ({@link setReposOpen}). Neither calls GitHub: in ONE
 *   transaction a change writes the fact, bumps its revision
 *   (`repos_access_rev`), audits it, and claims the project's
 *   `repos_access_job_at` lease when no live job holds it; the job is sent
 *   after the commit.
 * - **The permission** of every invitation reads the fact (`inviteAccount`,
 *   `access.ts`): `pull` on a repository the opening opens (`openingOf`),
 *   nothing otherwise — an Accept, a resend, the reconciliation and this
 *   job alike.
 * - **The job** ({@link runReposAccessJob}, `project.repos_access`) is the
 *   project's ONE runner of the opening on GitHub, in the leased frame of
 *   `lease.ts` (`runLeased`): each pass lists from the database and brings
 *   GitHub to the fact it read — while open, the seat of each repository the
 *   opening opens and nobody is let into is invited with `pull`
 *   (`inviteAccount`); while closed, every recorded live grant of the
 *   project's repositories is revoked (`revokeGrants`, a pending invitation
 *   cancelled first, the repository back to `none` once nobody is left) —
 *   never `revokeEnrollmentAccess`, which would cut the student's
 *   repositories of every other project. The lease is given back only while
 *   the revision is the one the pass read (`releaseWhile`); otherwise
 *   another pass runs on the project as it now stands. A close, a re-open
 *   and a close again while a pass worked are a new revision: whatever the
 *   interleaving of the owner's writes — and of an Accept or a resend in an
 *   open window —, the last pass leaves GitHub and `invitation_status` as
 *   the fact says. A project of another mode is never touched. A repository
 *   archived as its lock, a seat without a linked or with a stale account,
 *   a seat gone from the roster: skipped, never fatal for the others. A
 *   failure backdates the lease, a crash leaves it; the ticker claims either
 *   once expired ({@link claimReposAccessWork}).
 *
 * - **A widening** (ADR-149 §7, amending ADR-047 M6-06 (A)): a change of
 *   the work mode to one that invites with `push` from one that invited with
 *   less (`widensInvitations`, `online` to `hybrid` above all) bumps the same
 *   revision and claims the same lease in the mode's transaction
 *   (`setWorkMode`); the job's pass for a `push` mode ({@link widenPass})
 *   then brings every live grant up to `push` on GitHub, never down. The
 *   invitations sent afterwards carry `push` already (`collaboratorPermission`).
 *
 * STAFF ONLY: the routes load the project under `staffAccess`, the owner's
 * role checked by their loader (invariant 6). The student reads the
 * outcome through the project's student view alone (N-SEC-20).
 */
import type { FastifyInstance } from "fastify";
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";

import type { ProjectReposAccess } from "@quiz/contracts";
import { collaboratorPermission, openingOf, reposOpeningRefusal, type ReposOpeningRefusalCode } from "@quiz/domain";

import { audit, SYSTEM_ACTOR, type AuditActor } from "../../audit.js";
import { isoOrNull } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { classrooms, projectRepoAccess, projectRepos, projects } from "../../db/schema.js";
import { ownerRepo } from "../../github/app.js";
import { widenToWrite } from "../../github/collaborators.js";
import { PROJECT_REPOS_ACCESS_QUEUE } from "../../jobs.js";
import { notFoundError } from "../http.js";
import { followInvitation, inviteAccount, notRecorded, revokeGrants } from "./access.js";
import { reposHoldingWork } from "./commits.js";
import { isLive, releaseCounts } from "./deadline.js";
import { ProjectError } from "./errors.js";
import { repoMembers } from "./groupRepos.js";
import { claimLeases, leaseFree, runLeased, type LeasedRun, type ProjectJob } from "./lease.js";
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
 * its code); the fact written, its revision bumped and audited —
 * `project.repos_opened`, `project.repos_closed` — (the close's row lock
 * waits for an invitation recording its grant, `inviteAccount`); the lease
 * claimed when no live job holds it, the job sent after the commit — a job
 * holding it finds a new revision when its pass ends. A write that changes
 * nothing writes nothing, sends nothing: a close never touches a project
 * that is not open.
 */
export async function setReposOpen(app: FastifyInstance, config: AppConfig, projectId: string, open: boolean, actor: AuditActor, now: Date): Promise<void> {
  const job = await app.db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!project) throw notFoundError("project");
    if (open === (project.reposOpenedAt !== null)) return null;
    if (open) {
      const repos = await studentRepos(tx, project);
      const [context, work] = await Promise.all([openingContext(tx, project), reposHoldingWork(tx, project, repos)]);
      const { refusal, view } = reposOpening({ project, repos, counts: releaseCounts(project, repos), work, ...context });
      if (refusal) throw new ProjectError(refusal, "The repositories cannot be opened now");
      await audit(tx, { ...actor, action: "project.repos_opened", subjectType: "project", subjectId: projectId, payload: { openable: view.openable, nothingToOpen: view.nothingToOpen } });
    } else {
      await audit(tx, { ...actor, action: "project.repos_closed", subjectType: "project", subjectId: projectId, payload: { openedAt: project.reposOpenedAt!.toISOString() } });
    }
    const claim = leaseFree(project.reposAccessJobAt, now);
    await tx
      .update(projects)
      .set({ reposOpenedAt: open ? now : null, reposAccessRev: project.reposAccessRev + 1, ...(claim ? { reposAccessJobAt: now } : {}) })
      .where(eq(projects.id, projectId));
    return claim ? ({ projectId, lease: now.toISOString() } satisfies ProjectJob) : null;
  });
  await sendReposAccessJob(app, config, job);
}

/**
 * The job a write claimed, sent after its commit (null: a live job holds
 * the lease and finds the new revision when its pass ends). Without a
 * queue, in the request, as the deadline's staff actions run theirs.
 */
export async function sendReposAccessJob(app: FastifyInstance, config: AppConfig, job: ProjectJob | null): Promise<void> {
  if (job === null) return;
  if (app.boss) {
    await app.boss.send(PROJECT_REPOS_ACCESS_QUEUE, job);
    return;
  }
  await runReposAccessJob(app, config, job).catch((err: unknown) => app.log.error({ err, project: job.projectId }, "project repos access job failed"));
}

/** The ticker's claim: a lease a failed job backdated, or a crashed one left, once expired (`claimLeases`). */
export function claimReposAccessWork(db: Db, now: Date): Promise<ProjectJob[]> {
  return claimLeases(db, "reposAccessJobAt", now, sql`${projects.reposAccessJobAt} IS NOT NULL`);
}

/**
 * Open: the seat of every repository the opening opens and nobody is let
 * into — its state `none`, or no live grant (a revocation crashed before
 * its state) — invited with `pull`. Archived on GitHub as its lock (H8), a
 * repository takes no new collaborator: skipped, its state stays `none`.
 */
async function invitePass(app: FastifyInstance, run: LeasedRun, moved: () => Promise<boolean>): Promise<void> {
  const { project, octokit, each, lost } = run;
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
  await each(targets, async (repo) => {
    // The fact moved: the next pass decides (no invitation, nor its GitHub e-mail, a close would take back).
    if (await moved()) return;
    for (const member of await repoMembers(db, repo, project.classroomId)) {
      if (member.account === null) continue;
      const ctx = { actor: SYSTEM_ACTOR, log: app.log, now: app.clock.now(), via: "repos.open", failure: "invite_failed" } as const;
      const invited = await inviteAccount(db, octokit, repo, { ...member, account: member.account }, ctx).catch((err: unknown) => {
        // A stale account (the student relinks, then resends), or the opening that no longer holds: skipped. GitHub failing fails the step.
        if (!(err instanceof ProjectError) || err.code === "invite_failed") throw err;
        app.log.warn({ code: err.code, repo: repo.fullName }, "project repos access: an invitation was skipped");
        return null;
      });
      // Taken back (`gone`), nothing to follow; nor once another runner holds the work (it lists anew).
      if (invited !== null && !notRecorded(invited) && !lost()) await followInvitation(db, repo, invited.invitation);
    }
  });
}

/** Closed: every recorded live grant of the project's repositories revoked, one at a time. */
async function revokePass(app: FastifyInstance, run: LeasedRun, moved: () => Promise<boolean>): Promise<void> {
  const grants = await app.db
    .select({ grant: projectRepoAccess, repo: projectRepos })
    .from(projectRepoAccess)
    .innerJoin(projectRepos, eq(projectRepos.id, projectRepoAccess.repoId))
    .where(and(eq(projectRepos.projectId, run.project.id), isNull(projectRepoAccess.revokedAt)));
  await run.each(
    grants.map((g) => ({ ...g, fullName: g.repo.fullName })),
    async ({ grant, repo }) => {
      if (await moved()) return;
      const ctx = { actor: SYSTEM_ACTOR, log: app.log, now: app.clock.now(), via: "repos.close" } as const;
      await revokeGrants(app.db, [{ grant, repo, client: run.octokit }], grant.enrollmentId, ctx);
    },
  );
}

/**
 * A mode that invites with `push` (ADR-149 §7): every live grant of the
 * project's repositories brought up to `push` on GitHub (`widenToWrite`: a
 * collaborator's seat, a pending invitation, never lowering a higher one,
 * never inviting anyone), one repository at a time, each one where
 * something changed audited (`project_repo.access_widened`). A repository
 * deleted, not live or archived is skipped — one archived as its lock (H8)
 * is not widened when it is unarchived later, a limit ADR-149 §7 states —;
 * a locked one is not — its lock
 * is a ruleset nobody bypasses, whatever the permission (F-PROJ-09, ADR-130
 * §9), so `push` changes nothing there until it is lifted. A GitHub failure
 * fails the repository and the job: the ticker runs the pass again, which
 * finds the repositories done already unchanged.
 */
async function widenPass(app: FastifyInstance, run: LeasedRun, moved: () => Promise<boolean>): Promise<void> {
  const { project, octokit } = run;
  const grants = await app.db
    .select({ repo: projectRepos, githubUserId: projectRepoAccess.githubUserId })
    .from(projectRepoAccess)
    .innerJoin(projectRepos, eq(projectRepos.id, projectRepoAccess.repoId))
    .where(and(eq(projectRepos.projectId, project.id), isNull(projectRepoAccess.revokedAt), isNull(projectRepoAccess.revokingAt)));
  const accounts = new Map<string, Set<number>>();
  for (const { repo, githubUserId } of grants) accounts.set(repo.id, (accounts.get(repo.id) ?? new Set()).add(githubUserId));
  const repos = [...new Map(grants.map((g) => [g.repo.id, g.repo])).values()].filter((r) => isLive(r, project) && r.archivedAt === null);
  await run.each(repos, async (repo) => {
    if (await moved()) return;
    const { owner, repo: name } = ownerRepo(repo.fullName!);
    const raised = await widenToWrite(octokit, owner, name, accounts.get(repo.id)!);
    if (raised.collaborators + raised.invitations === 0) return;
    await audit(app.db, { ...SYSTEM_ACTOR, action: "project_repo.access_widened", subjectType: "project_repo", subjectId: repo.id, payload: { projectId: project.id, ...raised } });
  });
}

/**
 * The `project.repos_access` job (ADR-145, ADR-149 §7), in the leased frame
 * (`runLeased`): a pass for the fact the project holds — the opening's
 * under `online_seb`, the widening's in a mode that invites with `push`,
 * nothing under `online` —, the lease given back only while its revision
 * is the one the pass read, else another pass on the project as it stands.
 */
export async function runReposAccessJob(app: FastifyInstance, config: AppConfig, job: ProjectJob): Promise<void> {
  await runLeased(
    app,
    config,
    "reposAccessJobAt",
    job,
    "project repos access",
    async (run) => {
      const moved = async () => {
        const [row] = await app.db.select({ rev: projects.reposAccessRev }).from(projects).where(eq(projects.id, run.project.id));
        return row?.rev !== run.project.reposAccessRev;
      };
      if (run.project.workMode === "online_seb") await (run.project.reposOpenedAt === null ? revokePass : invitePass)(app, run, moved);
      else if (collaboratorPermission(run.project.workMode) === "push") await widenPass(app, run, moved);
    },
    { releaseWhile: (project) => eq(projects.reposAccessRev, project.reposAccessRev) },
  );
}
