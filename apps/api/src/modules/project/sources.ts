/**
 * The organization's repository browser (F-PROJ-01, M3-11's form), ported
 * from heig-classroom's `org-repos` routes (`modules/assignments/actions.ts`):
 * the repositories a project may hand out, and one of them — its branches,
 * the tree of its default branch, the protected files to suggest. Reads
 * serving a request: a rate limit fails at once (`HTTP_READ`).
 */
import {
  PROTECTED_FILE_SUGGESTIONS,
  type ProjectSourceDetail,
  type ProjectSourceRepo,
} from "@quiz/contracts";

import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { githubStatus, HTTP_READ } from "../../github/app.js";
import { classroomClient } from "./organization.js";

/** The platform's own repositories, never a source: `<slug>-squashed`, `<slug>-squashed-N`. */
const DISTRIBUTION = /-squashed(-\d+)?$/;
/** The tree is a picker, not a mirror. */
export const MAX_TREE_ENTRIES = 800;

/** The organization's repositories, the most recently pushed first (one page of 100, as heig-classroom). */
export async function listSources(db: Db, config: AppConfig, classroomId: string): Promise<ProjectSourceRepo[]> {
  const { org, client } = await classroomClient(db, config, classroomId);
  const { data } = await client.octokit.request("GET /orgs/{org}/repos", {
    org: org.login,
    sort: "pushed",
    direction: "desc",
    per_page: 100,
    request: HTTP_READ,
  });
  return data
    .filter((r) => !r.archived && !DISTRIBUTION.test(r.name))
    .map((r) => ({
      name: r.name,
      defaultBranch: r.default_branch ?? "main",
      private: r.private,
      pushedAt: r.pushed_at ?? null,
    }));
}

/** One repository of the organization; null when GitHub does not know it there. */
export async function sourceDetail(
  db: Db,
  config: AppConfig,
  classroomId: string,
  repo: string,
): Promise<ProjectSourceDetail | null> {
  const { org, client } = await classroomClient(db, config, classroomId);
  const { octokit } = client;
  const owner = org.login;
  let repoData;
  try {
    ({ data: repoData } = await octokit.request("GET /repos/{owner}/{repo}", {
      owner,
      repo,
      request: { retries: 0, ...HTTP_READ },
    }));
  } catch (err) {
    if (githubStatus(err) === 404) return null;
    throw err;
  }
  if (repoData.owner.login.toLowerCase() !== owner.toLowerCase()) return null;
  const branches = await octokit.paginate(octokit.rest.repos.listBranches, {
    owner,
    repo: repoData.name,
    per_page: 100,
    request: HTTP_READ,
  });
  let tree: ProjectSourceDetail["tree"] = [];
  let truncated = false;
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo: repoData.name,
      tree_sha: repoData.default_branch,
      recursive: "1",
      request: HTTP_READ,
    });
    const entries = data.tree.filter((e) => e.path && (e.type === "blob" || e.type === "tree"));
    tree = entries.slice(0, MAX_TREE_ENTRIES).map((e) => ({ path: e.path!, type: e.type as "blob" | "tree" }));
    truncated = data.truncated || entries.length > MAX_TREE_ENTRIES;
  } catch (err) {
    // An empty repository has no tree (409): nothing to pick.
    if (githubStatus(err) !== 409 && githubStatus(err) !== 404) throw err;
  }
  const files = new Set(tree.filter((e) => e.type === "blob").map((e) => e.path));
  return {
    name: repoData.name,
    defaultBranch: repoData.default_branch,
    branches: branches.map((b) => b.name),
    tree,
    truncated,
    suggestedProtected: PROTECTED_FILE_SUGGESTIONS.filter((p) => files.has(p)),
  };
}
