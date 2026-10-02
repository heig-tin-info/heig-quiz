/**
 * Protected files (F-PROJ-08, as amended 2026-10-02; merge task M3-04): a
 * push by anyone but Quiz's App — a student, or a workflow's own commit —
 * that touches a protected file of a handed-out branch is answered by a
 * restore commit of the App putting back the distribution repository's
 * current version of each (`revertProtectedFiles`, `github/revert.ts`).
 *
 * Past five restores in an hour on one repository, restoring stops: the
 * repository's `protection_suspended_at` is set (audited
 * `project_repo.revert_cap`) until the staff re-enable it (M3-08), and the
 * runs ingested meanwhile are `to_verify` (`grading.ts`). The cap is
 * counted under the repository row's lock, as the restore is recorded.
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
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, count, eq, gte, inArray } from "drizzle-orm";
import type { Octokit } from "octokit";

import { audit, SYSTEM_ACTOR } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { botCommits, projectGradeRuns, projectRepos, reverts } from "../../db/schema.js";
import { githubStatus, installationClient, isZeroSha, ownerRepo } from "../../github/app.js";
import { changedFiles, revertProtectedFiles, type RevertResult } from "../../github/revert.js";
import { projectInstallation } from "../github/service.js";
import { refreshScoreSelection, restoredHeads } from "./grading.js";
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
    .select({ id: reverts.id })
    .from(reverts)
    .where(and(eq(reverts.repoId, repo.id), eq(reverts.headSha, push.after)))
    .limit(1);
  if (answered) return;
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
    // not happen, so it neither counts nor answers the push. Any other
    // failure may have moved the branch: the record stays.
    if (recorded.sha !== null && githubStatus(err) === 422) {
      await db.delete(reverts).where(and(eq(reverts.repoId, repo.id), eq(reverts.revertSha, recorded.sha)));
    }
    throw err;
  }
  if (!result) return;
  await audit(db, {
    ...SYSTEM_ACTOR,
    action: "project_repo.restore",
    subjectType: "project_repo",
    subjectId: repo.id,
    payload: { files: result.files, sha: result.sha, head: push.after, covered: result.covered },
  });
  // Every head the restore covered (`restoredHeads`: the pushed one and the
  // later pushes already on the branch) ran the student's copy of the
  // protected files: its runs flagged, and out of the score, whether they
  // finished before the restore or after.
  await db
    .update(projectGradeRuns)
    .set({ toVerify: true })
    .where(and(eq(projectGradeRuns.repoId, repo.id), inArray(projectGradeRuns.headSha, [...(await restoredHeads(db, ctx))])));
  await refreshScoreSelection(db, ctx);
}

/**
 * Records a restore commit before the branch moves onto it, under the
 * repository row's lock so that two pushes cannot both pass the cap: the
 * bot commit and the `reverts` row (the restore's count, answering the push
 * by its head). Past the cap, the protection is suspended instead (audited
 * once) and false refuses the move.
 */
async function recordRestore(db: Db, ctx: RepoContext, push: ProtectedPush, commit: RevertResult, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(projectRepos).where(eq(projectRepos.id, ctx.repo.id)).for("update");
    if (!row || row.protectionSuspendedAt !== null) return false;
    const [recent] = await tx
      .select({ n: count() })
      .from(reverts)
      .where(and(eq(reverts.repoId, row.id), gte(reverts.createdAt, new Date(now.getTime() - HOUR_MS))));
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
    const [counted] = await tx
      .insert(reverts)
      .values({
        id: randomUUID(),
        repoId: row.id,
        revertSha: commit.sha,
        files: commit.files,
        headSha: push.after,
        coveredSha: commit.covered,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: reverts.id });
    if (!counted) return false; // the same push answered meanwhile
    await tx.insert(botCommits).values({ repoId: row.id, sha: commit.sha, kind: "revert" }).onConflictDoNothing();
    return true;
  });
}
