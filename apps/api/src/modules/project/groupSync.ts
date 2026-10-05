/**
 * The `group.sync` job (ADR-070 §4, F-PROJ-06/13; merge task M3-15b-2): a
 * group set's moves that reach a copy group with a repository, applied on
 * GitHub for one project at a time, under the project's own lease
 * (`group_sync_job_at`, ADR-064's claim, renewal and expiry).
 *
 * **What it does**, from the pure diff of the set and the copy re-read
 * under its locks (`syncSteps`, the stops included):
 *
 * - **a departure waits for GitHub**: under the job's locks, while the
 *   student still departs and the group has not stopped, their recorded
 *   accounts on the repository marked `revoking_at` (`beginDeparture`;
 *   otherwise the departure is held, nothing touched); then taken out (a
 *   pending invitation cancelled first) and confirmed `revoked_at` —
 *   `revokeDeparture`; nothing to take (the App gone,
 *   the repository deleted, no account ever invited) is audited skipped and
 *   the move proceeds (P1); only then does the student leave the copy's
 *   group (`completeDeparture`), for the set's new group if it follows, or
 *   for none. GitHub refusing leaves them in it with *access to revoke*
 *   (`revoke_failed_at`), retried by the next pass;
 * - **an arrival** is written to the copy, then invited (best effort: a
 *   student with no linked account is invited when they link, or accept);
 * - **a stray grant** (`STRAY_GRANT`: an access GitHub kept when an
 *   invitation could not be taken back) is revoked as it stands.
 *
 * **When it runs**: sent right after a set's write that leaves such a move
 * (`requestGroupSync`), and claimed by the ticker while
 * `group_sync_due_at` has come. A pass that fails moves the due mark later,
 * 30 s doubling up to an hour; one that leaves nothing waiting clears it.
 * Without a queue (`JOBS_DISABLED=1`) nothing sends it and the moves wait:
 * the set's writes stay correct, the copy simply keeps the student where
 * GitHub still lets them in.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Octokit } from "octokit";

import { SYSTEM_ACTOR } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { classrooms, enrollments, projectRepos, projects } from "../../db/schema.js";
import { githubApp, githubStatus } from "../../github/app.js";
import { PROJECT_GROUP_SYNC_QUEUE } from "../../jobs.js";
import { redactTokens } from "../../redact.js";
import { followInvitation, inviteAccount, revocationClient, revokeDeparture, RevokeFailed, type RevokeContext } from "./access.js";
import { isLive, ts } from "./deadline.js";
import { repoChanged } from "./events.js";
import { beginDeparture, beginStrayRevocation, completeArrival, completeDeparture, flagRevokeFailed, settleSync, syncSteps } from "./groupCopy.js";
import { groupRepoWhere, repoMembers } from "./groupRepos.js";
import { claimLeases, FAILED_RETRY_MS, heldLease, type ProjectJob } from "./lease.js";
import type { ProjectRow } from "./views.js";

/** The longest a failed pass waits for its retry. */
export const SYNC_RETRY_MAX_MS = 60 * 60_000;

/** When the pass after `failures` failed ones in a row may run: {@link FAILED_RETRY_MS}, doubling, at most an hour. */
export const syncRetryAt = (now: Date, failures: number): Date =>
  new Date(now.getTime() + Math.min(SYNC_RETRY_MAX_MS, FAILED_RETRY_MS * 2 ** Math.min(failures - 1, 20)));

/** The lease of every project whose moves are due (or of `projectId` only), taken when it is free or expired. */
export function claimGroupSyncWork(db: Db, now: Date, projectId?: string): Promise<ProjectJob[]> {
  return claimLeases(db, "groupSyncJobAt", now, sql`${projects.groupSyncDueAt} <= ${ts(now)}`, projectId);
}

/**
 * Right after a set's write that left moves waiting for GitHub: each
 * project's lease claimed and its job sent. Without Quiz's App or a queue,
 * nothing is sent (the ticker claims nothing either without a queue).
 */
export async function requestGroupSync(app: FastifyInstance, config: AppConfig, projectIds: readonly string[]): Promise<void> {
  if (!githubApp(config) || !app.boss || projectIds.length === 0) return;
  const now = app.clock.now();
  for (const projectId of projectIds) {
    for (const job of await claimGroupSyncWork(app.db, now, projectId)) await app.boss.send(PROJECT_GROUP_SYNC_QUEUE, job);
  }
}

/** What one pass did, for the hints and the job's outcome: the roster lines whose place changed, the steps that failed. */
interface Pass {
  moved: Set<string>;
  failed: number;
}

/** The repository of copy group `groupId`, if it has one. */
async function groupRepo(db: Db, projectId: string, groupId: string) {
  const [repo] = await db.select().from(projectRepos).where(groupRepoWhere(projectId, groupId));
  return repo ?? null;
}

/**
 * The student invited on the repository of copy group `groupId`, best
 * effort: nothing without the App, a live repository, or a linked account
 * (a repository still provisioned invites its members once made).
 */
async function inviteMember(app: FastifyInstance, client: Octokit | null, project: ProjectRow, groupId: string, enrollmentId: string): Promise<void> {
  const repo = await groupRepo(app.db, project.id, groupId);
  if (client === null || repo === null || !isLive(repo, project)) return;
  const member = (await repoMembers(app.db, repo, project.classroomId)).find((m) => m.enrollmentId === enrollmentId);
  if (!member?.account) return;
  const ctx = { actor: SYSTEM_ACTOR, now: app.clock.now(), log: app.log, via: "group.sync", failure: "invite_failed" } as const;
  try {
    const invited = await inviteAccount(app.db, client, repo, { ...member, account: member.account }, ctx);
    if (typeof invited === "object") await followInvitation(app.db, repo, invited.invitation);
  } catch (err) {
    app.log.warn({ err, repo: repo.id, enrollmentId }, "group.sync: an invitation failed");
  }
}

/** GitHub's answer when it refused a revocation — the flag's reason, never a token —; null when GitHub did not answer (a failure, a provisioning under way). */
function refusalReason(err: unknown): string | null {
  const cause = err instanceof RevokeFailed ? err.cause : undefined;
  const status = githubStatus(cause);
  if (status === undefined) return null;
  return redactTokens(`GitHub ${status}: ${(cause as { message?: string }).message ?? ""}`);
}

const revokeContext = (app: FastifyInstance): RevokeContext => ({ actor: SYSTEM_ACTOR, now: app.clock.now(), log: app.log, via: "group.sync" });

/**
 * One departure out of copy group `groupId`: held when a stop or the set
 * came first (`beginDeparture`); else the access revoked — a refusal by
 * GitHub flags *access to revoke* —, the copy written, the next group's
 * repository invited, or the access given back when the set put the
 * student back meanwhile.
 */
async function depart(app: FastifyInstance, client: Octokit | null, project: ProjectRow, step: { enrollmentId: string; groupId: string }, pass: Pass) {
  const db = app.db;
  const repo = await groupRepo(db, project.id, step.groupId);
  if (repo === null) return;
  const marked = await beginDeparture(db, project.id, step.enrollmentId, step.groupId, repo.id, app.clock.now());
  if (marked === "held") return;
  try {
    await revokeDeparture(db, client, repo, step.enrollmentId, marked, revokeContext(app));
  } catch (err) {
    const reason = refusalReason(err);
    if (reason !== null) await flagRevokeFailed(db, project.id, step.enrollmentId, step.groupId, reason, app.clock.now());
    throw err;
  }
  const done = await completeDeparture(db, project.id, step.enrollmentId, step.groupId, repo.id, app.clock.now());
  if (done.outcome === "gone") return;
  pass.moved.add(step.enrollmentId);
  if (done.outcome === "kept") await inviteMember(app, client, project, step.groupId, step.enrollmentId);
  if (done.outcome === "moved") await inviteMember(app, client, project, done.to, step.enrollmentId);
}

/** One arrival into copy group `groupId`: written, then invited. */
async function arrive(app: FastifyInstance, client: Octokit | null, project: ProjectRow, step: { enrollmentId: string; groupId: string }, pass: Pass) {
  if (!(await completeArrival(app.db, project.id, step.enrollmentId, step.groupId, app.clock.now()))) return;
  pass.moved.add(step.enrollmentId);
  await inviteMember(app, client, project, step.groupId, step.enrollmentId);
}

/** One stray grant revoked, if it still is one. */
async function revokeStray(app: FastifyInstance, client: Octokit | null, project: ProjectRow, step: { grantId: string }) {
  const found = await beginStrayRevocation(app.db, project.id, step.grantId, app.clock.now());
  if (found !== null) await revokeDeparture(app.db, client, found.repo, found.grant.enrollmentId, [found.grant], revokeContext(app));
}

/** The course's staff and the moved students hear of it (never the classroom's topic, N-SEC-20). */
async function hintMoved(db: Db, project: ProjectRow, moved: ReadonlySet<string>): Promise<void> {
  if (moved.size === 0) return;
  const [room] = await db.select({ courseId: classrooms.courseId }).from(classrooms).where(eq(classrooms.id, project.classroomId));
  const lines = await db
    .select({ userId: enrollments.userId })
    .from(enrollments)
    .where(and(inArray(enrollments.id, [...moved]), eq(enrollments.classroomId, project.classroomId)));
  repoChanged(
    room!.courseId,
    lines.flatMap((l) => (l.userId === null ? [] : [l.userId])),
  );
}

/**
 * The `group.sync` job: nothing when its lease is no longer the row's; else
 * every departure, every arrival, every stray grant, the lease renewed
 * after each and the pass stopped once it is lost; then, under the job's
 * locks, the due mark cleared or moved later (`settleSync`), the lease
 * given back. A failed step fails the job (for the queue's log) once the
 * rest is done. A crash leaves the lease to expire and the marks
 * (`revoking_at`) for the next pass to ask GitHub again.
 */
export async function runGroupSyncJob(app: FastifyInstance, config: AppConfig, job: ProjectJob): Promise<void> {
  const db = app.db;
  const [project] = await db.select().from(projects).where(eq(projects.id, job.projectId));
  if (!project?.groupSyncJobAt || project.groupSyncJobAt.toISOString() !== job.lease) return;
  const lease = heldLease(app, "groupSyncJobAt", project.id, project.groupSyncJobAt);
  const pass: Pass = { moved: new Set(), failed: 0 };
  const run = async (what: string, step: () => Promise<void>) => {
    if (lease.lost()) return;
    await step().catch((err: unknown) => {
      app.log.error({ err, project: project.id }, `group.sync: ${what} failed`);
      pass.failed += 1;
    });
    await lease.renew();
  };
  try {
    const client = await revocationClient(db, config, project.orgId);
    const steps = await syncSteps(db, project.id, app.clock.now());
    for (const step of steps.departures) await run("a departure", () => depart(app, client, project, step, pass));
    for (const step of steps.arrivals) await run("an arrival", () => arrive(app, client, project, step, pass));
    for (const step of steps.strays) await run("a stray grant's revocation", () => revokeStray(app, client, project, step));
  } catch (err) {
    app.log.error({ err, project: project.id }, "group.sync: the pass failed");
    pass.failed += 1;
  }
  await hintMoved(db, project, pass.moved);
  if (lease.lost()) return;
  const now = app.clock.now();
  await settleSync(db, project.id, now, pass.failed > 0 ? (failures) => syncRetryAt(now, failures) : null);
  await lease.release();
  if (pass.failed > 0) throw new Error(`group.sync incomplete: ${pass.failed} step(s) failed`);
}
