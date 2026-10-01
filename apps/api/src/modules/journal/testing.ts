/**
 * A journal repository on the fake GitHub of `github/testing.ts`, for the
 * journal's tests: the four REST routes the ingestion calls (the repository
 * by id, a branch's head, the tree, a blob), answered from a world the test
 * mutates, and the blob reads recorded; then the routes of the writes
 * ({@link writeRoute}), which change that world as GitHub would. Test
 * support only; nothing in the application imports it.
 */
import { createHash } from "node:crypto";

import { json, type Route } from "../../github/testing.js";

export interface FakeFile {
  path: string;
  content: string | Buffer;
  /** The blob sha; by default derived from the content, as git does. */
  sha?: string;
  /** The size the tree reports; by default the content's. */
  size?: number;
}

export interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  /** GitHub's id of the owner (`GET /repos/{owner}/{repo}`); 0 by default. */
  ownerId?: number;
  /** `main` by default. */
  defaultBranch?: string;
  /** An `owner/name` it was transferred or renamed from, which GitHub still resolves to it. */
  formerly?: string;
  /** Branch -> head and files; a repository without branches is empty (409). */
  branches: Record<string, { commit: string; files: FakeFile[] }>;
  /** Heads no branch points at any more, still readable by sha (see {@link pushTo}). */
  history?: { commit: string; files: FakeFile[] }[];
  /** False: GitHub answers 404 for it (deleted, or out of the installation's reach). */
  exists?: boolean;
  truncated?: boolean;
  /** A status GitHub answers every route of the repository with (a 500, a 403). */
  failWith?: number;
  /** GitHub answers every route of the repository with its spent quota: 403, `x-ratelimit-remaining: 0`. */
  rateLimited?: boolean;
}

export const blobSha = (file: FakeFile): string =>
  file.sha ?? createHash("sha1").update(file.content).digest("hex");

/** GitHub's answer once the installation's quota is spent, for an hour. */
function rateLimitedAnswer(): Response {
  return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
    status: 403,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    },
  });
}

/** The routes of `repos()`. `reads` receives the sha of every blob read. */
export function repoRoute(repos: () => FakeRepo[], reads: string[] = []): Route {
  const byName = (owner: string, name: string) =>
    repos().find((r) => r.exists !== false && r.owner === owner && r.name === name);
  return (url, init) => {
    if (url.host !== "api.github.com" || init.method !== "GET") return undefined;
    const path = decodeURIComponent(url.pathname);
    let m: RegExpExecArray | null;
    if ((m = /^\/repositories\/(\d+)$/.exec(path))) {
      const repo = repos().find((r) => r.exists !== false && r.id === Number(m![1]));
      if (!repo) return undefined;
      if (repo.rateLimited) return rateLimitedAnswer();
      if (repo.failWith) return json({ message: "failure" }, repo.failWith);
      return json({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner } });
    }
    if (!(m = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(path))) return undefined;
    const repo = byName(m[1]!, m[2]!);
    if (!repo) return undefined;
    if (repo.failWith) return json({ message: "failure" }, repo.failWith);
    const rest = m[3]!;
    const heads = () => [...Object.values(repo.branches), ...(repo.history ?? [])];
    if ((m = /^commits\/(.+)$/.exec(rest))) {
      const branch = repo.branches[m[1]!];
      if (Object.keys(repo.branches).length === 0) return json({ message: "Git Repository is empty." }, 409);
      return branch ? json({ sha: branch.commit }) : json({ message: "No commit found" }, 422);
    }
    if ((m = /^git\/trees\/([^/]+)$/.exec(rest))) {
      const branch = heads().find((b) => b.commit === m![1]);
      if (!branch) return undefined;
      return json({
        sha: branch.commit,
        truncated: repo.truncated ?? false,
        tree: branch.files.map((f) => ({
          path: f.path,
          type: "blob",
          mode: "100644",
          sha: blobSha(f),
          size: f.size ?? Buffer.byteLength(f.content),
        })),
      });
    }
    if ((m = /^git\/blobs\/([^/]+)$/.exec(rest))) {
      const sha = m[1]!;
      const file = heads()
        .flatMap((b) => b.files)
        .find((f) => blobSha(f) === sha);
      if (!file) return undefined;
      reads.push(sha);
      return json({ sha, encoding: "base64", content: Buffer.from(file.content).toString("base64") });
    }
    return undefined;
  };
}

// ---------------------------------------------------------------- the writes (M4-03)

/** One commit the platform made through the Contents API. */
export interface FakeCommit {
  repo: string;
  method: "PUT" | "DELETE";
  path: string;
  branch: string;
  message: string;
  author: { name: string; email: string } | undefined;
  committer: unknown;
}

/** The world of the writes: its repositories (shared with {@link repoRoute}), and what was done to them. */
export interface FakeWorld {
  repos: FakeRepo[];
  /** GitHub's id of each organization by login, for the repositories created in it. */
  orgIds: Record<string, number>;
  /** GitHub accounts, id → login (`GET /user/{id}`); an id missing is a deleted account. */
  accounts: Map<number, string>;
  /** Logins GitHub refuses to invite (403). */
  refused: Set<string>;
  commits: FakeCommit[];
  invitations: { repo: string; login: string; permission: unknown }[];
  nextId: number;
}

export function fakeWorld(repos: FakeRepo[] = []): FakeWorld {
  return { repos, orgIds: {}, accounts: new Map(), refused: new Set(), commits: [], invitations: [], nextId: 90_000 };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const repoJson = (r: FakeRepo, status = 200) =>
  json(
    {
      id: r.id,
      name: r.name,
      full_name: `${r.owner}/${r.name}`,
      private: true,
      default_branch: r.defaultBranch ?? "main",
      owner: { login: r.owner, id: r.ownerId ?? 0 },
    },
    status,
  );

/**
 * The routes the writes call, on `world`: a repository by name (following
 * `formerly`), its creation (422 on a name taken), the Contents API's put and
 * delete with GitHub's lock (409 on a stale sha, 422 on a sha missing or
 * unexpected), a collaborator's invitation, an account by id.
 */
export function writeRoute(world: FakeWorld): Route {
  const byName = (owner: string, name: string) =>
    world.repos.find(
      (r) =>
        r.exists !== false &&
        ((same(r.owner, owner) && same(r.name, name)) || (r.formerly !== undefined && same(r.formerly, `${owner}/${name}`))),
    );
  return (url, init) => {
    if (url.host !== "api.github.com") return undefined;
    const path = decodeURIComponent(url.pathname);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    let m: RegExpExecArray | null;
    if (init.method === "GET" && (m = /^\/user\/(\d+)$/.exec(path))) {
      const login = world.accounts.get(Number(m[1]));
      return login ? json({ id: Number(m[1]), login }) : undefined;
    }
    if (init.method === "POST" && (m = /^\/orgs\/([^/]+)\/repos$/.exec(path))) {
      const org = m[1]!;
      const name = String(body.name);
      if (byName(org, name)) return json({ message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] }, 422);
      const repo: FakeRepo = { id: world.nextId++, owner: org, ownerId: world.orgIds[org] ?? 0, name, branches: {} };
      world.repos.push(repo);
      return repoJson(repo, 201);
    }
    if (init.method === "GET" && (m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path))) {
      const repo = byName(m[1]!, m[2]!);
      return repo ? repoJson(repo) : undefined;
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/collaborators\/([^/]+)$/.exec(path)) && init.method === "PUT") {
      const repo = byName(m[1]!, m[2]!);
      if (!repo) return undefined;
      const login = m[3]!;
      if (world.refused.has(login)) return json({ message: "Resource not accessible by integration" }, 403);
      world.invitations.push({ repo: `${repo.owner}/${repo.name}`, login, permission: body.permission });
      return json({ id: world.invitations.length }, 201);
    }
    if (!(m = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(path))) return undefined;
    if (init.method !== "PUT" && init.method !== "DELETE") return undefined;
    const repo = byName(m[1]!, m[2]!);
    if (!repo) return undefined;
    if (repo.failWith) return json({ message: "failure" }, repo.failWith);
    const file = m[3]!;
    const branch = String(body.branch ?? repo.defaultBranch ?? "main");
    const empty = Object.keys(repo.branches).length === 0;
    const head = repo.branches[branch];
    if (!head && !(empty && init.method === "PUT")) return json({ message: `Branch ${branch} not found` }, 404);
    const files = head?.files ?? [];
    const existing = files.find((f) => f.path === file);
    if (init.method === "DELETE" && !existing) return json({ message: "Not Found" }, 404);
    if (existing && !body.sha) return json({ message: '"sha" wasn\'t supplied.' }, 422);
    if (existing && body.sha !== blobSha(existing)) return json({ message: `${file} does not match ${String(body.sha)}` }, 409);
    if (!existing && body.sha) return json({ message: "sha given for a file that does not exist" }, 422);
    const rest = files.filter((f) => f.path !== file);
    const put = init.method === "PUT" ? { path: file, content: Buffer.from(String(body.content), "base64") } : null;
    const commit = pushTo(repo, put ? [...rest, put] : rest, branch);
    world.commits.push({
      repo: `${repo.owner}/${repo.name}`,
      method: init.method,
      path: file,
      branch,
      message: String(body.message),
      author: body.author as FakeCommit["author"],
      committer: body.committer,
    });
    return json({ content: put ? { path: file, sha: blobSha(put) } : null, commit: { sha: commit } }, put && !existing ? 201 : 200);
  };
}

/** Moves `branch` of `repo` to a new head holding `files`, the old head kept readable; returns the new sha. */
export function pushTo(repo: FakeRepo, files: FakeFile[], branch = "main"): string {
  const old = repo.branches[branch];
  if (old) (repo.history ??= []).push(old);
  const commit = createHash("sha1").update(`${repo.id}:${branch}:${repo.history?.length ?? 0}:${Math.random()}`).digest("hex");
  repo.branches[branch] = { commit, files };
  return commit;
}
