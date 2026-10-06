/**
 * Student repository provisioning on acceptance (GH-20..25), ported from
 * spike S2. Each step checks the state before acting: a full replay is
 * safe (recovery after partial failure, NFR-09).
 *
 * Lesson from the spike: NEVER list the refs of a freshly created repository
 * (409 "Git Repository is empty" that Octokit's retry plugin stretches into
 * ~40 s of backoff), and `retries: 0` everywhere a 4xx carries meaning.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Octokit } from "octokit";

import { inviteCollaborator } from "./collaborators.js";
import { gitRunner, repoUrl } from "./git.js";
import { pushWithRetry } from "./retry.js";

// Classroom's name, kept: the repositories it provisioned carry this ruleset,
// and Quiz's App manages them after the cutover (03-github-projects.md §3.4).
const PROTECT_RULESET = "hgc-protect";

/**
 * GitHub Free serves no repository ruleset on a private repository and answers
 * 403 "Upgrade to GitHub Pro or make this repository public to enable this
 * feature." Recognised by its wording so that a genuine permission 403 (App
 * scope revoked, SAML enforcement) keeps failing the provisioning loudly.
 */
const PLAN_RESTRICTION = /upgrade to github|make this repository public/i;

/** Also the one case where the deadline's lock archives instead (H8, `lock.ts`). */
export function isPlanRestriction(err: unknown): boolean {
  const { status, message } = err as { status?: number; message?: string };
  return status === 403 && PLAN_RESTRICTION.test(String(message ?? ""));
}


/**
 * The `hgc-protect` ruleset on a student repository's default branch
 * (non-fast-forward and deletion, GH-21..23): its id, or null where the
 * organization's plan serves no ruleset on a private repository
 * ({@link isPlanRestriction}). Idempotent — a ruleset of that name already
 * there is adopted, never created twice — so provisioning and the daily
 * reconciliation (M3-14k) share it. Any other failure throws.
 */
export async function protectStudentRepo(octokit: Octokit, org: string, repo: string): Promise<number | null> {
  try {
    const { data: rulesets } = await octokit.request("GET /repos/{owner}/{repo}/rulesets", { owner: org, repo });
    const existing = rulesets.find((r: { name: string; id: number }) => r.name === PROTECT_RULESET);
    if (existing) return existing.id;
    const { data } = await octokit.request("POST /repos/{owner}/{repo}/rulesets", {
      owner: org,
      repo,
      name: PROTECT_RULESET,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [{ type: "non_fast_forward" }, { type: "deletion" }],
    });
    return data.id;
  } catch (err) {
    if (!isPlanRestriction(err)) throw err;
    return null;
  }
}

/**
 * The target name is held by a repository the caller may not adopt: nothing
 * was pushed to it, changed on it, nor anyone invited on it.
 */
export class RepoNameTaken extends Error {
  constructor(readonly fullName: string) {
    super(`${fullName} already exists and is not this row's repository`);
    this.name = "RepoNameTaken";
  }
}

export interface ProvisionResult {
  repoId: number;
  fullName: string;
  defaultBranch: string;
  rulesetId: number | null;
  /** `pending` if an invitation was created, `accepted` if already a collaborator. */
  invitationStatus: "pending" | "accepted";
}

export async function provisionStudentRepo(opts: {
  octokit: Octokit;
  token: string;
  org: string;
  squashedRepo: string;
  targetRepo: string;
  branches: string[];
  defaultBranch: string;
  studentLogin: string;
  /**
   * The allow-list of the repository (M3-03 review): called with its id and
   * whether this call created it, BEFORE anything is pushed to it, changed
   * on it or anyone invited on it. A created repository is recorded by the
   * caller; an existing one (the 422 of a name taken) is adopted only when
   * the caller recorded it already — a replay of its own creation. False
   * aborts with {@link RepoNameTaken}: a name is chosen by a student (their
   * login), so it may name any repository of the organization.
   */
  claim: (repoId: number, created: boolean) => Promise<boolean>;
}): Promise<ProvisionResult> {
  const { octokit, token, org, squashedRepo, targetRepo, branches, studentLogin } = opts;
  // Provisioning only clones and pushes existing refs: no bot identity needed.
  const { git, gitBare } = gitRunner({ token });
  const url = (repo: string) => repoUrl(org, repo);

  // 1. Creation (idempotent: 422 name already exists = step already done).
  let created = true;
  let repoId: number;
  let fullName: string;
  try {
    const { data } = await octokit.request("POST /orgs/{org}/repos", {
      org,
      name: targetRepo,
      private: true,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
      request: { retries: 0 },
    });
    repoId = Number(data.id);
    fullName = data.full_name;
  } catch (err) {
    if ((err as { status?: number }).status !== 422) throw err;
    created = false;
    const { data } = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: org,
      repo: targetRepo,
    });
    repoId = Number(data.id);
    fullName = data.full_name;
  }
  if (!(await opts.claim(repoId, created))) throw new RepoNameTaken(fullName);

  // 2. Push of the squashed repo's refs (skipped if the default branch already exists).
  let needPush = true;
  if (!created) {
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/git/matching-refs/{ref}",
        { owner: org, repo: targetRepo, ref: `heads/${opts.defaultBranch}`, request: { retries: 0 } },
      );
      needPush = data.length === 0;
    } catch (err) {
      if ((err as { status?: number }).status !== 409) throw err; // empty, so push
    }
  }
  if (needPush) {
    const work = mkdtempSync(join(tmpdir(), "quiz-prov-"));
    try {
      await git(work, "clone", "--quiet", "--bare", url(squashedRepo), "src.git");
      const refspecs = branches.map((b) => `refs/heads/${b}:refs/heads/${b}`);
      // The freshly created repository may still be provisioning on GitHub's
      // side: retry the push on transient failures instead of surfacing
      // "provisioning failed" to the student.
      await pushWithRetry(() =>
        gitBare(join(work, "src.git"), "push", "--quiet", url(targetRepo), ...refspecs),
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  // 2b. Align the default branch with the assignment's first selected
  // branch. GitHub keeps the account-level default (`main`) on an empty
  // repo even when only `master` gets pushed; review commits then target a
  // branch that does not exist and fall to the backup branch (seen live
  // 2026-07-14: GRADING parked on `grading` for a main/master mismatch).
  try {
    const { data: meta } = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: org,
      repo: targetRepo,
    });
    if (meta.default_branch !== opts.defaultBranch) {
      await octokit.request("PATCH /repos/{owner}/{repo}", {
        owner: org,
        repo: targetRepo,
        default_branch: opts.defaultBranch,
      });
    }
  } catch {
    // Best effort: a failed alignment must not fail the provisioning.
  }

  // 3. Ruleset against force-push / deletion (GH-21..23). On a plan without
  // rulesets the repository stays unprotected rather than being denied to the
  // student: same degraded mode as the deadline (fallback H8), which archives
  // when it cannot lock. The daily reconciliation applies it once the plan
  // allows it (M3-14k); the teacher is warned on the project page meanwhile.
  const rulesetId = await protectStudentRepo(octokit, org, targetRepo);

  // 4. Invite the student (idempotent: 204 = already a collaborator), with
  //    the `push` permission and never more (N-SEC-21). Quiz has no work
  //    mode (D09): heig-classroom's `pull` and no-invitation modes are gone.
  const invitationStatus = await inviteCollaborator(octokit, org, targetRepo, studentLogin, "push");

  return {
    repoId,
    fullName,
    defaultBranch: opts.defaultBranch,
    rulesetId,
    invitationStatus,
  };
}
