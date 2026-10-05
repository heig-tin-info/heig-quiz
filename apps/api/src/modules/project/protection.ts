/**
 * Protected files (F-PROJ-08, as amended 2026-10-02; merge task M3-04): a
 * push by anyone but Quiz's App — a student, or a workflow's own commit —
 * that touches a protected file of a handed-out branch is answered by a
 * restore commit of the App putting back the distribution repository's
 * current version of each (`revertProtectedFiles`, `github/revert.ts`).
 *
 * Past five restores in an hour on one repository, restoring stops: the
 * repository's `protection_suspended_at` is set (audited
 * `project_repo.revert_cap`) until the staff re-enable it
 * ({@link reenableProtection}, M3-08b), and the runs ingested meanwhile are
 * `to_verify` (`grading.ts`). The cap is counted under the repository row's
 * lock, as the restore is recorded, over the restores since the last
 * re-enable.
 *
 * A run on a head the App restored ran the student's own copy of the
 * protected files (a tampered `grading.yml`): it is kept, `to_verify`, and
 * never the score (`selectScoreRun` of `@quiz/domain`), whichever of the
 * run and the restore came first.
 *
 * Idempotent (ADR-011): a push is answered once, by its head
 * (`reverts.head_sha`, unique per repository), so a redelivery never
 * restores, nor counts toward the cap, twice; and a restore leaves out every
 * file already the distribution's, so a retry after a crash commits nothing.
 * The restore is recorded (its count and its bot commit) BEFORE the branch
 * moves, so a crash after the move loses neither.
 *
 * GitHub refusing the move (a student's push raced it, a 422) leaves the row
 * without its restore (`revert_sha` null, M3-06b) and the delivery is
 * retried: a retry that can restore fills the row in; one that finds the
 * files put back by the student leaves it — the push is answered, its
 * head's runs stay `to_verify`, and no restore is counted. An ordinary push
 * leaving the files the distribution's is no tampering and writes no row.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, count, eq, gt, gte, isNotNull, isNull } from "drizzle-orm";
import type { Octokit } from "octokit";

import type { ProjectRepoProtection } from "@quiz/contracts";

import { audit, SYSTEM_ACTOR, type AuditActor } from "../../audit.js";
import { iso, isoOrNull } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { botCommits, projectRepos, reverts } from "../../db/schema.js";
import { githubStatus, installationClient, isZeroSha, ownerRepo } from "../../github/app.js";
import { changedFiles, revertProtectedFiles, type RevertResult } from "../../github/revert.js";
import { projectInstallation } from "../github/service.js";
import { liveRepoForUpdate } from "./deadline.js";
import { refreshScoreSelection } from "./grading.js";
import type { RepoContext } from "./repos.js";

/** Restores in an hour past which restoring stops (F-PROJ-08). */
export const MAX_RESTORES_PER_HOUR = 5;
const HOUR_MS = 3_600_000;
/** GitHub lists at most this many commits in a push's payload. */
const PAYLOAD_COMMITS_MAX = 20;

/** What the check reads of a push. */
export interface ProtectedPush {
  branch: string;
  before?: string | undefined;
  after: string;
  forced: boolean;
  commits: { added?: string[] | undefined; modified?: string[] | undefined; removed?: string[] | undefined }[];
}

/**
 * The paths the push may have changed, or null for "any": the payload's
 * own lists, unless they cannot tell (decided 2026-10-02) — a forced push,
 * or 20 commits listed (GitHub's cap) — then GitHub's compare; a new branch
 * has nothing to compare with.
 */
async function touchedFiles(octokit: Octokit, fullName: string, push: ProtectedPush): Promise<Set<string> | null> {
  if (!push.before || isZeroSha(push.before)) return null;
  if (push.forced || push.commits.length >= PAYLOAD_COMMITS_MAX) {
    const { owner, repo } = ownerRepo(fullName);
    const files = await changedFiles(octokit, owner, repo, push.before, push.after);
    return files === null ? null : new Set(files);
  }
  return new Set(push.commits.flatMap((c) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]));
}

/**
 * Answers a push not made by the App: restores the protected files it
 * touched, or suspends the protection past the cap. A no-op for a branch
 * not handed out, a project without protected files or distribution, a
 * repository whose protection is suspended, a push already answered.
 */
export async function protectFiles(
  app: FastifyInstance,
  config: AppConfig,
  ctx: RepoContext,
  push: ProtectedPush,
): Promise<void> {
  const { project, repo } = ctx;
  const db = app.db;
  if (
    project.protectedFiles.length === 0 ||
    !project.branches.includes(push.branch) ||
    !project.distributionFullName ||
    !repo.fullName ||
    repo.protectionSuspendedAt !== null
  ) {
    return;
  }
  const [answered] = await db
    .select({ revertSha: reverts.revertSha })
    .from(reverts)
    .where(and(eq(reverts.repoId, repo.id), eq(reverts.headSha, push.after)))
    .limit(1);
  if (answered?.revertSha != null) return;
  /** A row without its restore: the retry of a move GitHub refused (M3-06b). */
  const pending = answered !== undefined;
  const org = await projectInstallation(db, project.orgId);
  if (!org) return;
  const { octokit } = await installationClient(config, org.installationId);

  const touched = await touchedFiles(octokit, repo.fullName, push);
  const hit = project.protectedFiles.filter((f) => touched === null || touched.has(f));
  if (hit.length === 0) return;

  const now = app.clock.now();
  const { owner, repo: studentRepo } = ownerRepo(repo.fullName);
  /** The restore commit recorded, once `beforeMove` has. */
  const recorded: { sha: string | null } = { sha: null };
  let result: RevertResult | null;
  try {
    result = await revertProtectedFiles({
      octokit,
      org: owner,
      studentRepo,
      squashedRepo: ownerRepo(project.distributionFullName).repo,
      branch: push.branch,
      paths: hit,
      beforeMove: async (commit) => {
        if (!(await recordRestore(db, ctx, push, commit, now))) return false;
        recorded.sha = commit.sha;
        return true;
      },
    });
  } catch (err) {
    // GitHub refused the move (a student's push raced it): the restore did
    // not happen, so it neither counts nor covers a later head — the row
    // keeps the tampered head alone, without its restore, for the retry.
    // Any other failure may have moved the branch: the record stays.
    if (recorded.sha !== null && githubStatus(err) === 422) {
      await db
        .update(reverts)
        .set({ revertSha: null, coveredSha: null })
        .where(and(eq(reverts.repoId, repo.id), eq(reverts.revertSha, recorded.sha)));
    }
    throw err;
  }
  if (result) {
    await audit(db, {
      ...SYSTEM_ACTOR,
      action: "project_repo.restore",
      subjectType: "project_repo",
      subjectId: repo.id,
      payload: { files: result.files, sha: result.sha, head: push.after, covered: result.covered },
    });
  } else if (!pending) {
    return; // the files are the distribution's already: nothing to answer
  }
  // Every head the restore covered (`restoredHeads`: the pushed one and the
  // later pushes already on the branch — the pushed one alone after a 422
  // whose retry found nothing left to restore) ran the student's copy of the
  // protected files: its runs flagged, and out of the score, whether they
  // finished before the restore or after.
  await refreshScoreSelection(db, ctx);
}

/**
 * Records a restore commit before the branch moves onto it, under the
 * repository row's lock so that two pushes cannot both pass the cap: the
 * bot commit and the `reverts` row (the restore's count, answering the push
 * by its head). Past the cap, the protection is suspended instead (audited
 * once) and false refuses the move. A row left without its restore by a 422
 * (M3-06b) is filled in, and only then counts.
 */
async function recordRestore(db: Db, ctx: RepoContext, push: ProtectedPush, commit: RevertResult, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(projectRepos).where(eq(projectRepos.id, ctx.repo.id)).for("update");
    if (!row || row.protectionSuspendedAt !== null) return false;
    // Only the restores after a re-enable count toward the cap again (M3-08b);
    // a move that did not happen (`revert_sha` null) never did.
    const [recent] = await tx
      .select({ n: count() })
      .from(reverts)
      .where(
        and(
          eq(reverts.repoId, row.id),
          isNotNull(reverts.revertSha),
          gte(reverts.createdAt, new Date(now.getTime() - HOUR_MS)),
          row.protectionReenabledAt === null ? undefined : gt(reverts.createdAt, row.protectionReenabledAt),
        ),
      );
    if ((recent?.n ?? 0) >= MAX_RESTORES_PER_HOUR) {
      await tx.update(projectRepos).set({ protectionSuspendedAt: now }).where(eq(projectRepos.id, row.id));
      await audit(tx, {
        ...SYSTEM_ACTOR,
        action: "project_repo.revert_cap",
        subjectType: "project_repo",
        subjectId: row.id,
        payload: { files: commit.files, head: push.after },
      });
      return false;
    }
    const restore = { revertSha: commit.sha, files: commit.files, coveredSha: commit.covered, branch: push.branch, createdAt: now };
    const [counted] = await tx
      .insert(reverts)
      .values({ id: randomUUID(), repoId: row.id, headSha: push.after, ...restore })
      // The row a 422 left without its restore takes this one; a row with its restore is left alone.
      .onConflictDoUpdate({
        target: [reverts.repoId, reverts.headSha],
        targetWhere: isNotNull(reverts.headSha),
        set: restore,
        setWhere: isNull(reverts.revertSha),
      })
      .returning({ id: reverts.id });
    if (!counted) return false; // the same push answered meanwhile
    await tx.insert(botCommits).values({ repoId: row.id, sha: commit.sha, kind: "revert" }).onConflictDoNothing();
    return true;
  });
}

/**
 * `POST /app/api/projects/:id/repos/:rid/protection` (F-PROJ-08; M3-08b,
 * product owner's decision 4 of 2026-10-02): the staff re-enable the
 * restores on a repository marked "protected files in conflict". Clears
 * `protection_suspended_at` and records the time (`protection_reenabled_at`)
 * so that only the restores after it count toward the cap; the runs flagged
 * `to_verify` during the suspension stay so; nothing is restored now — the
 * next push that touches a protected file is. Its final review, skipped
 * while suspended, is due again (`FINAL_REVIEW_DUE`, `review.ts`). A
 * repository not suspended is left as it is, nothing audited. Audited
 * `project_repo.protection_reenabled`.
 */
export async function reenableProtection(
  db: Db,
  projectId: string,
  repoId: string,
  actor: AuditActor,
  now: Date,
): Promise<ProjectRepoProtection> {
  return db.transaction(async (tx) => {
    const { repo } = await liveRepoForUpdate(tx, projectId, repoId);
    if (repo.protectionSuspendedAt === null) return { reenabledAt: isoOrNull(repo.protectionReenabledAt) };
    await tx
      .update(projectRepos)
      .set({ protectionSuspendedAt: null, protectionReenabledAt: now })
      .where(eq(projectRepos.id, repo.id));
    await audit(tx, {
      ...actor,
      action: "project_repo.protection_reenabled",
      subjectType: "project_repo",
      subjectId: repo.id,
      payload: { suspendedAt: iso(repo.protectionSuspendedAt) },
    });
    return { reenabledAt: iso(now) };
  });
}
