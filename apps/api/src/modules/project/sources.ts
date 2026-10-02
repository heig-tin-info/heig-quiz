/**
 * The source repositories of the classroom's organization (F-PROJ-01):
 * the one reading of a source that the creation and the browser share
 * ({@link fetchSource}), and the browser of M3-11's form, ported from
 * heig-classroom's `org-repos` routes (`modules/assignments/actions.ts`).
 * Reads serving a request: a rate limit fails at once (`HTTP_READ`).
 */
import { eq } from "drizzle-orm";

import {
  PROTECTED_FILE_SUGGESTIONS,
  type ProjectSourceDetail,
  type ProjectSourceRepo,
} from "@quiz/contracts";

import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { projects } from "../../db/schema.js";
import { githubStatus, HTTP_READ, installationClient, type InstallationClient } from "../../github/app.js";
import { classroomInstallation, type InstalledOrg } from "../github/service.js";
import { ProjectError } from "./errors.js";

/** The platform's own repositories, never a source: `<slug>-squashed`, `<slug>-squashed-N`. */
const DISTRIBUTION = /-squashed(-\d+)?$/;
/** The tree is a picker, not a mirror. */
export const MAX_TREE_ENTRIES = 800;

/** The App's client on the classroom's organization; `409 not_connected` or `app_not_installed` otherwise. */
export async function classroomClient(
  db: Db,
  config: AppConfig,
  classroomId: string,
): Promise<{ org: InstalledOrg; client: InstallationClient }> {
  const found = await classroomInstallation(db, classroomId);
  if ("refused" in found) throw new ProjectError(found.refused, `Quiz's GitHub App cannot act for this classroom (${found.refused})`);
  return { org: found.org, client: await installationClient(config, found.org.installationId) };
}

/** A source as GitHub describes it, and its branches. */
export interface Source {
  id: number;
  name: string;
  fullName: string;
  defaultBranch: string;
  branches: string[];
}

/**
 * The repository `name` of the classroom's organization, if it may be a
 * source; null otherwise: unknown to GitHub there; resolved into another
 * organization (GitHub follows a renamed or transferred repository, the
 * owner is checked by its immutable id); or one of the platform's own
 * distribution repositories, by its name or because a project holds it
 * (a project handed out from another's distribution would have its
 * solution-free copy as its source, and its receipts tangled with it).
 */
export async function fetchSource(db: Db, client: InstallationClient, org: InstalledOrg, name: string): Promise<Source | null> {
  if (DISTRIBUTION.test(name)) return null;
  let data;
  try {
    ({ data } = await client.octokit.request("GET /repos/{owner}/{repo}", {
      owner: org.login,
      repo: name,
      request: { retries: 0, ...HTTP_READ },
    }));
  } catch (err) {
    if (githubStatus(err) === 404) return null;
    throw err;
  }
  const sameOrg =
    org.githubOrgId !== null
      ? Number(data.owner.id) === org.githubOrgId
      : data.owner.login.toLowerCase() === org.login.toLowerCase();
  if (!sameOrg || DISTRIBUTION.test(data.name)) return null;
  const id = Number(data.id);
  const [held] = await db.select({ id: projects.id }).from(projects).where(eq(projects.distributionRepoId, id)).limit(1);
  if (held) return null;
  const branches = await client.octokit.paginate(client.octokit.rest.repos.listBranches, {
    owner: org.login,
    repo: data.name,
    per_page: 100,
    request: HTTP_READ,
  });
  return {
    id,
    name: data.name,
    fullName: data.full_name,
    defaultBranch: data.default_branch,
    branches: branches.map((b) => b.name),
  };
}

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

/** One source of the organization ({@link fetchSource}); null when it may not be one. */
export async function sourceDetail(
  db: Db,
  config: AppConfig,
  classroomId: string,
  name: string,
): Promise<ProjectSourceDetail | null> {
  const { org, client } = await classroomClient(db, config, classroomId);
  const source = await fetchSource(db, client, org, name);
  if (!source) return null;
  let tree: ProjectSourceDetail["tree"] = [];
  let truncated = false;
  try {
    const { data } = await client.octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner: org.login,
      repo: source.name,
      tree_sha: source.defaultBranch,
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
    name: source.name,
    defaultBranch: source.defaultBranch,
    branches: source.branches,
    tree,
    truncated,
    suggestedProtected: PROTECTED_FILE_SUGGESTIONS.filter((p) => files.has(p)),
  };
}
