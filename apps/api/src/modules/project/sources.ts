/**
 * The source repositories of the classroom's organization (F-PROJ-01):
 * the one reading of a source that the creation and the browser share
 * ({@link fetchSource}), and the browser of M3-11's form, ported from
 * heig-classroom's `org-repos` routes (`modules/assignments/actions.ts`).
 * Reads serving a request: a rate limit fails at once (`HTTP_READ`).
 */
import {
  PROTECTED_FILE_SUGGESTIONS,
  type ProjectSourceDetail,
  type ProjectSourceRepo,
} from "@quiz/contracts";

import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { githubStatus, HTTP_READ, installationClient, unless404, type InstallationClient } from "../../github/app.js";
import { classroomInstallation, heldRepos, offLimitsRepos, type InstalledOrg } from "../github/service.js";
import type { Caller } from "../guards.js";
import { ProjectError } from "./errors.js";

/** The platform's own repositories, never a source: `<slug>-squashed`, `<slug>-squashed-N`. */
const DISTRIBUTION = /-squashed(-\d+)?$/;
/** The browser's list: at most this many sources, read from at most `SOURCE_PAGES` pages of the organization. */
const MAX_SOURCES = 100;
const SOURCE_PAGES = 10;
const PER_PAGE = 100;
/** The tree is a picker, not a mirror. */
export const MAX_TREE_ENTRIES = 800;

/**
 * GitHub's pages, from the first, until a short one or `max` are read.
 * Each page is one `request` of the caller's, so every page carries its
 * `HTTP_READ`: `octokit.paginate` passes the request options to the first
 * page only, and a later one would wait out a rate limit (`failFast`).
 */
async function* pagesOf<T>(read: (page: number) => Promise<T[]>, max = Number.POSITIVE_INFINITY): AsyncGenerator<T[]> {
  for (let page = 1; page <= max; page++) {
    const data = await read(page);
    yield data;
    if (data.length < PER_PAGE) return;
  }
}

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
 * owner is checked by its immutable id); or one {@link notSources} names —
 * the 404 of a missing one.
 */
export async function fetchSource(
  db: Db,
  client: InstallationClient,
  org: InstalledOrg,
  name: string,
  caller: Caller,
): Promise<Source | null> {
  if (DISTRIBUTION.test(name)) return null;
  const data = await unless404(async () => {
    const { data } = await client.octokit.request("GET /repos/{owner}/{repo}", {
      owner: org.login,
      repo: name,
      request: { retries: 0, ...HTTP_READ },
    });
    return data;
  });
  if (data === null) return null;
  const sameOrg =
    org.githubOrgId !== null
      ? Number(data.owner.id) === org.githubOrgId
      : data.owner.login.toLowerCase() === org.login.toLowerCase();
  if (!sameOrg) return null;
  const id = Number(data.id);
  if ((await notSources(db, caller, [{ id, name: data.name }])).has(id)) return null;
  const branches: { name: string }[] = [];
  for await (const page of pagesOf(async (page) => {
    const { data: list } = await client.octokit.request("GET /repos/{owner}/{repo}/branches", {
      owner: org.login,
      repo: data.name,
      per_page: PER_PAGE,
      page,
      request: HTTP_READ,
    });
    return list;
  })) {
    branches.push(...page);
  }
  return {
    id,
    name: data.name,
    fullName: data.full_name,
    defaultBranch: data.default_branch,
    branches: branches.map((b) => b.name),
  };
}

/**
 * The repositories among `repos` that may never be a source: the
 * platform's own, by the distribution's name (`<slug>-squashed`) or because
 * a project holds it — its distribution, a student's or a group's
 * repository (a project handed out from another's would have a student's
 * work, or a solution-free copy, as its source, and its receipts tangled
 * with it) —, and those Quiz knows as a course's where the caller holds no
 * seat (`offLimitsRepos`, ADR-100 §5). The one rule the browser and the
 * creation share.
 */
async function notSources(db: Db, caller: Caller, repos: { id: number; name: string }[]): Promise<Set<number>> {
  const ids = repos.map((r) => r.id);
  if (ids.length === 0) return new Set();
  const [held, offLimits] = await Promise.all([heldRepos(db, ids), offLimitsRepos(db, caller, ids)]);
  const excluded = new Set([...held, ...offLimits]);
  for (const r of repos) if (DISTRIBUTION.test(r.name)) excluded.add(r.id);
  return excluded;
}

/**
 * The organization's sources, the most recently pushed first: its
 * repositories less the archived ones and {@link notSources}, read page by
 * page until `MAX_SOURCES` are kept — the students' repositories, pushed to
 * last, would otherwise fill the first page — or `SOURCE_PAGES` are read.
 */
export async function listSources(db: Db, config: AppConfig, classroomId: string, caller: Caller): Promise<ProjectSourceRepo[]> {
  const { org, client } = await classroomClient(db, config, classroomId);
  const pages = pagesOf(async (page) => {
    const { data } = await client.octokit.request("GET /orgs/{org}/repos", {
      org: org.login,
      sort: "pushed",
      direction: "desc",
      per_page: PER_PAGE,
      page,
      request: HTTP_READ,
    });
    return data;
  }, SOURCE_PAGES);
  const sources: ProjectSourceRepo[] = [];
  for await (const data of pages) {
    const page = data.filter((r) => !r.archived).map((r) => ({ ...r, id: Number(r.id) }));
    const excluded = await notSources(db, caller, page);
    for (const r of page) {
      if (excluded.has(r.id)) continue;
      sources.push({ name: r.name, defaultBranch: r.default_branch ?? "main", private: r.private, pushedAt: r.pushed_at ?? null });
    }
    if (sources.length >= MAX_SOURCES) break;
  }
  return sources.slice(0, MAX_SOURCES);
}

/** One source of the organization ({@link fetchSource}); null when it may not be one. */
export async function sourceDetail(
  db: Db,
  config: AppConfig,
  classroomId: string,
  name: string,
  caller: Caller,
): Promise<ProjectSourceDetail | null> {
  const { org, client } = await classroomClient(db, config, classroomId);
  const source = await fetchSource(db, client, org, name, caller);
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
