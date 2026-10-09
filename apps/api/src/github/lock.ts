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

/** The rules a ruleset of this file applies (GitHub's rule types). */
type RulesetRule = { type: "update" | "creation" | "deletion" | "non_fast_forward" };

/** The id of the repository's ruleset named `name`, if it has one. */
async function findRuleset(octokit: Octokit, org: string, repo: string, name: string): Promise<number | undefined> {
  const { data: rulesets } = await octokit.request("GET /repos/{owner}/{repo}/rulesets", { owner: org, repo });
  return rulesets.find((r: { name: string; id: number }) => r.name === name)?.id;
}

/**
 * The ruleset `name` on the repository, active on the refs `include`
 * names: its id. Idempotent — a ruleset of that name already there is
 * adopted, never created twice.
 */
export async function ensureRuleset(
  octokit: Octokit,
  org: string,
  repo: string,
  ruleset: { name: string; include: string[]; rules: RulesetRule[] },
): Promise<number> {
  const existing = await findRuleset(octokit, org, repo, ruleset.name);
  if (existing !== undefined) return existing;
  const { data } = await octokit.request("POST /repos/{owner}/{repo}/rulesets", {
    owner: org,
    repo,
    name: ruleset.name,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ruleset.include, exclude: [] } },
    rules: ruleset.rules,
  });
  return data.id;
}

export async function lockStudentRepo(
  octokit: Octokit,
  org: string,
  repo: string,
): Promise<number> {
  return ensureRuleset(octokit, org, repo, {
    name: LOCK_RULESET,
    include: ["~ALL"],
    rules: [{ type: "update" }, { type: "creation" }, { type: "deletion" }],
  });
}

export async function unlockStudentRepo(
  octokit: Octokit,
  org: string,
  repo: string,
): Promise<void> {
  const existing = await findRuleset(octokit, org, repo, LOCK_RULESET);
  if (existing === undefined) return; // already unlocked, idempotent
  await octokit.request("DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
    owner: org,
    repo,
    ruleset_id: existing,
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
