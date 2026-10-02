/**
 * Locking/unlocking of a student repository via ruleset (GH-41), a
 * mechanism validated by spike S2: while locked, every push is refused
 * (App and org admin bypass), removal reopens the repository. Used by the
 * deadline job and the staff's lock and unlock (F-PROJ-09, merge task
 * M3-05a, `modules/project/deadline.ts`).
 *
 * The fallback H8, on a plan without rulesets: the repository is archived
 * instead (read-only for everyone, the App included), and un-archived to
 * unlock it. Never on a GitHub failure — a 5xx or a rate limit is retried —
 * only where rulesets cannot exist (`isPlanRestriction`, `provision.ts`).
 */
import type { Octokit } from "octokit";

// Classroom's name, kept: a repository it locked must be unlockable by Quiz's
// App after the cutover (03-github-projects.md §3.4).
const LOCK_RULESET = "hgc-deadline-lock";

export async function lockStudentRepo(
  octokit: Octokit,
  org: string,
  repo: string,
): Promise<number> {
  const { data: rulesets } = await octokit.request("GET /repos/{owner}/{repo}/rulesets", {
    owner: org,
    repo,
  });
  const existing = rulesets.find((r: { name: string; id: number }) => r.name === LOCK_RULESET);
  if (existing) return existing.id;
  const { data } = await octokit.request("POST /repos/{owner}/{repo}/rulesets", {
    owner: org,
    repo,
    name: LOCK_RULESET,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
    rules: [{ type: "update" }, { type: "creation" }, { type: "deletion" }],
  });
  return data.id;
}

export async function unlockStudentRepo(
  octokit: Octokit,
  org: string,
  repo: string,
): Promise<void> {
  const { data: rulesets } = await octokit.request("GET /repos/{owner}/{repo}/rulesets", {
    owner: org,
    repo,
  });
  const existing = rulesets.find((r: { name: string; id: number }) => r.name === LOCK_RULESET);
  if (!existing) return; // already unlocked, idempotent
  await octokit.request("DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
    owner: org,
    repo,
    ruleset_id: existing.id,
  });
}

/** Archives the repository (H8's lock), or un-archives it; idempotent. */
export async function setRepoArchived(
  octokit: Octokit,
  org: string,
  repo: string,
  archived: boolean,
): Promise<void> {
  await octokit.request("PATCH /repos/{owner}/{repo}", { owner: org, repo, archived });
}
