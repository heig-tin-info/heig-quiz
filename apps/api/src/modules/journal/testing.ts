/**
 * A journal repository on the fake GitHub of `github/testing.ts`, for the
 * journal's tests: the four REST routes the ingestion calls (the repository
 * by id, a branch's head, the tree, a blob), answered from a world the test
 * mutates, and the blob reads recorded. Test support only; nothing in the
 * application imports it.
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
  /** Branch -> head and files; a repository without branches is empty (409). */
  branches: Record<string, { commit: string; files: FakeFile[] }>;
  /** Heads no branch points at any more, still readable by sha (see {@link pushTo}). */
  history?: { commit: string; files: FakeFile[] }[];
  /** False: GitHub answers 404 for it (deleted, or out of the installation's reach). */
  exists?: boolean;
  truncated?: boolean;
  /** A status GitHub answers every route of the repository with (a 500, a 403). */
  failWith?: number;
}

export const blobSha = (file: FakeFile): string =>
  file.sha ?? createHash("sha1").update(file.content).digest("hex");

/**
 * The routes of `repos()`. `reads` receives the sha of every blob read;
 * `onHead` runs when a branch's head is read (a test moves the repository
 * there, between two ingestions).
 */
export function repoRoute(
  repos: () => FakeRepo[],
  reads: string[] = [],
  onHead: (repo: FakeRepo) => void = () => {},
): Route {
  const byName = (owner: string, name: string) =>
    repos().find((r) => r.exists !== false && r.owner === owner && r.name === name);
  return (url, init) => {
    if (url.host !== "api.github.com" || init.method !== "GET") return undefined;
    const path = decodeURIComponent(url.pathname);
    let m: RegExpExecArray | null;
    if ((m = /^\/repositories\/(\d+)$/.exec(path))) {
      const repo = repos().find((r) => r.exists !== false && r.id === Number(m![1]));
      if (!repo) return undefined;
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
      const answer =
        Object.keys(repo.branches).length === 0
          ? json({ message: "Git Repository is empty." }, 409)
          : branch
            ? json({ sha: branch.commit })
            : json({ message: "No commit found" }, 422);
      onHead(repo); // after the answer: the repository moves on behind this reader
      return answer;
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

/** Moves `branch` of `repo` to a new head holding `files`, the old head kept readable; returns the new sha. */
export function pushTo(repo: FakeRepo, files: FakeFile[], branch = "main"): string {
  const old = repo.branches[branch];
  if (old) (repo.history ??= []).push(old);
  const commit = createHash("sha1").update(`${repo.id}:${branch}:${repo.history?.length ?? 0}:${Math.random()}`).digest("hex");
  repo.branches[branch] = { commit, files };
  return commit;
}
