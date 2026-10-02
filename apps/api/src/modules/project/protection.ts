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
 * runs ingested meanwhile are `to_verify` (`grading.ts`).
 *
 * Idempotent (ADR-011): a push is answered once, by its head
 * (`reverts.head_sha`, unique per repository), so a redelivery never
 * restores, nor counts toward the cap, twice; and a restore leaves out every
 * file already the distribution's, so a retry after a crash commits nothing.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, count, eq, gte, isNull } from "drizzle-orm";
import type { Octokit } from "octokit";

import { audit, SYSTEM_ACTOR } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { botCommits, projectRepos, reverts } from "../../db/schema.js";
import { installationClient } from "../../github/app.js";
import { changedFiles, revertProtectedFiles } from "../../github/revert.js";
import { projectInstallation } from "../github/service.js";
import type { RepoContext } from "./repos.js";

/** Restores in an hour past which restoring stops (F-PROJ-08). */
export const MAX_RESTORES_PER_HOUR = 5;
const HOUR_MS = 3_600_000;
/** GitHub lists at most this many commits in a push's payload. */
const PAYLOAD_COMMITS_MAX = 20;
const ZERO_SHA = /^0+$/;

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
  if (!push.before || ZERO_SHA.test(push.before)) return null;
  if (push.forced || push.commits.length >= PAYLOAD_COMMITS_MAX) {
    const [owner, repo] = fullName.split("/") as [string, string];
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
  const [recent] = await db
    .select({ n: count() })
    .from(reverts)
    .where(and(eq(reverts.repoId, repo.id), gte(reverts.createdAt, new Date(now.getTime() - HOUR_MS))));
  if ((recent?.n ?? 0) >= MAX_RESTORES_PER_HOUR) {
    const [suspended] = await db
      .update(projectRepos)
      .set({ protectionSuspendedAt: now })
      .where(and(eq(projectRepos.id, repo.id), isNull(projectRepos.protectionSuspendedAt)))
      .returning({ id: projectRepos.id });
    if (suspended) {
      await audit(db, {
        ...SYSTEM_ACTOR,
        action: "project_repo.revert_cap",
        subjectType: "project_repo",
        subjectId: repo.id,
        payload: { files: hit, head: push.after },
      });
    }
    return;
  }

  const [owner, studentRepo] = repo.fullName.split("/") as [string, string];
  const result = await revertProtectedFiles({
    octokit,
    org: owner,
    studentRepo,
    squashedRepo: project.distributionFullName.split("/")[1]!,
    branch: push.branch,
    paths: hit,
    beforeMove: async (sha) => {
      await db.insert(botCommits).values({ repoId: repo.id, sha, kind: "revert" }).onConflictDoNothing();
    },
  });
  if (!result) return;
  const [recorded] = await db
    .insert(reverts)
    .values({ id: randomUUID(), repoId: repo.id, revertSha: result.sha, files: result.files, headSha: push.after, createdAt: now })
    .onConflictDoNothing()
    .returning({ id: reverts.id });
  if (!recorded) return;
  await audit(db, {
    ...SYSTEM_ACTOR,
    action: "project_repo.restore",
    subjectType: "project_repo",
    subjectId: repo.id,
    payload: { files: result.files, sha: result.sha, head: push.after },
  });
}
