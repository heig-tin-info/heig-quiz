/**
 * The organizations' repositories for the project tests: local BARE
 * repositories under one directory, `<dir>/<org>/<repo>.git`, which git
 * clones and pushes to for real once `setRemoteBaseForTests` points the
 * remotes there, and a route of the fake GitHub (`github/testing.ts`) that
 * answers the REST calls about them from what is on disk: create (422 on a
 * name taken), a repository, its first commit (409 when empty), its
 * branches, an organization's listing, a tree. A repository may refuse
 * pushes (a `pre-receive` hook), to stand for GitHub failing a build
 * halfway. Test support only; nothing in the application imports it.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { json, type Route } from "../../github/testing.js";

const sh = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString();

export interface RepoWorld {
  /** The directory `setRemoteBaseForTests` is given (as `file://<dir>`). */
  dir: string;
  /** GitHub's id of each organization, by login. */
  orgIds: Record<string, number>;
  /** GitHub's id of each repository, by `org/name`. */
  ids: Map<string, number>;
  /** Owners GitHub reports for a repository other than its organization: a transferred one. */
  foreignOwner: Set<string>;
  /** While true, a repository the App creates refuses every push. */
  refusePushes: boolean;
  /** A repository with commits on `branches` (`file` → content), as a teacher pushed it. */
  source: (org: string, name: string, branches: Record<string, Record<string, string>>, commits?: number) => void;
  /** The empty repository `org/name`, as a failed build leaves it. */
  empty: (org: string, name: string) => void;
  /** Lets every repository refused so far take pushes again. */
  allowPushes: () => void;
  exists: (fullName: string) => boolean;
  /** `git` on a bare repository of the world. */
  git: (fullName: string, ...args: string[]) => string;
  remove: () => void;
  route: Route;
}

export function repoWorld(): RepoWorld {
  const dir = mkdtempSync(join(tmpdir(), "quiz-remotes-"));
  const pathOf = (fullName: string) => join(dir, `${fullName}.git`);
  const refusing: string[] = [];
  let nextId = 70_000;

  const init = (fullName: string) => {
    mkdirSync(dirname(pathOf(fullName)), { recursive: true });
    sh("init", "-q", "--bare", "-b", "main", pathOf(fullName));
    world.ids.set(fullName, nextId++);
  };
  const branchesOf = (fullName: string) =>
    sh("--git-dir", pathOf(fullName), "for-each-ref", "--format=%(refname:short)", "refs/heads")
      .split("\n")
      .filter(Boolean);
  const defaultOf = (fullName: string) => {
    const branches = branchesOf(fullName);
    return branches.includes("main") ? "main" : (branches[0] ?? "main");
  };
  const repoJson = (org: string, name: string) => ({
    id: world.ids.get(`${org}/${name}`),
    name,
    full_name: `${org}/${name}`,
    private: true,
    archived: false,
    default_branch: world.exists(`${org}/${name}`) ? defaultOf(`${org}/${name}`) : "main",
    pushed_at: "2026-09-30T08:00:00Z",
    owner: { login: org, id: world.foreignOwner.has(`${org}/${name}`) ? 999_999 : (world.orgIds[org] ?? 0) },
  });

  const world: RepoWorld = {
    dir,
    orgIds: {},
    ids: new Map(),
    foreignOwner: new Set(),
    refusePushes: false,
    source(org, name, branches, commits = 1) {
      const fullName = `${org}/${name}`;
      init(fullName);
      const work = mkdtempSync(join(tmpdir(), "quiz-source-"));
      try {
        for (const [branch, files] of Object.entries(branches)) {
          const tree = join(work, branch);
          sh("init", "-q", "-b", branch, tree);
          for (let c = 0; c < commits; c++) {
            for (const [path, content] of Object.entries(files)) {
              mkdirSync(dirname(join(tree, path)), { recursive: true });
              writeFileSync(join(tree, path), `${content}${c === 0 ? "" : ` v${c}`}`);
            }
            sh("-C", tree, "add", "-A");
            sh("-C", tree, "-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgsign=false", "commit", "-q", "-m", `c${c}`);
          }
          sh("-C", tree, "push", "-q", pathOf(fullName), `${branch}:${branch}`);
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    empty(org, name) {
      init(`${org}/${name}`);
    },
    allowPushes() {
      for (const hook of refusing.splice(0)) rmSync(hook, { force: true });
      world.refusePushes = false;
    },
    exists: (fullName) => existsSync(pathOf(fullName)),
    git: (fullName, ...args) => sh("--git-dir", pathOf(fullName), ...args),
    remove: () => rmSync(dir, { recursive: true, force: true }),
    route: (url, req) => {
      if (url.host !== "api.github.com") return undefined;
      const path = decodeURIComponent(url.pathname);
      let m: RegExpExecArray | null;
      if (req.method === "POST" && (m = /^\/orgs\/([^/]+)\/repos$/.exec(path))) {
        const org = m[1]!;
        const name = String((JSON.parse(String(req.body)) as { name: string }).name);
        const fullName = `${org}/${name}`;
        if (world.exists(fullName)) {
          return json({ message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] }, 422);
        }
        init(fullName);
        if (world.refusePushes) {
          const hook = join(pathOf(fullName), "hooks", "pre-receive");
          writeFileSync(hook, "#!/bin/sh\necho refused >&2\nexit 1\n");
          chmodSync(hook, 0o755);
          refusing.push(hook);
        }
        return json(repoJson(org, name), 201);
      }
      if (req.method !== "GET") return undefined;
      if ((m = /^\/orgs\/([^/]+)\/repos$/.exec(path))) {
        const org = m[1]!;
        const names = [...world.ids.keys()].filter((f) => f.startsWith(`${org}/`)).map((f) => f.slice(org.length + 1));
        return json(names.map((n) => repoJson(org, n)));
      }
      if (!(m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path))) return undefined;
      const [org, name, rest = ""] = [m[1]!, m[2]!, m[3]];
      const fullName = `${org}/${name}`;
      if (!world.exists(fullName)) return undefined;
      if (rest === "") return json(repoJson(org, name));
      const branches = branchesOf(fullName);
      if (rest === "/commits") {
        return branches.length === 0
          ? json({ message: "Git Repository is empty." }, 409)
          : json([{ sha: world.git(fullName, "rev-parse", branches[0]!).trim() }]);
      }
      if (rest === "/branches") return json(branches.map((b) => ({ name: b, protected: false })));
      if ((m = /^\/git\/trees\/(.+)$/.exec(rest))) {
        if (branches.length === 0) return json({ message: "Git Repository is empty." }, 409);
        const entries = world
          .git(fullName, "ls-tree", "-r", "-t", m[1]!)
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [meta, entryPath] = line.split("\t");
            return { path: entryPath, type: meta!.split(" ")[1], mode: meta!.split(" ")[0], sha: meta!.split(" ")[2] };
          });
        return json({ sha: m[1], truncated: false, tree: entries });
      }
      return undefined;
    },
  };
  return world;
}
