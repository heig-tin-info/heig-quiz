/**
 * The organizations' repositories for the project tests: local BARE
 * repositories under one directory, `<dir>/<org>/<repo>.git`, which git
 * clones and pushes to for real once `setRemoteBaseForTests` points the
 * remotes there, and a route of the fake GitHub (`github/testing.ts`) that
 * answers the REST calls about them from what is on disk: create (422 on a
 * name taken), a repository, its first commit (409 when empty), its
 * branches and matching refs, an organization's listing, a tree. A
 * repository may refuse pushes (a `pre-receive` hook), to stand for GitHub
 * failing a build halfway. In memory beside them (M3-03): the default branch
 * a `PATCH` sets, the rulesets (or the free plan's 403), the collaborators
 * invited and their permission. From M3-04, the Git Data API a restore
 * calls (a file's contents, blobs, trees, commits, a ref moved fast-forward
 * only), a compare, and `commit` for a push made outside the App. From
 * M3-05a, a ruleset deleted and a repository archived (read-only until
 * un-archived). From M3-15b, a collaborator removed and the pending
 * invitations listed and cancelled (a revocation), or refused (`unrevokable`).
 * Test support only; nothing in the application imports it.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { json, type Route } from "../../github/testing.js";

const sh = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString();
/** `git` with an environment (a temporary index, an author) and a standard input. */
const shWith = (env: Record<string, string>, input: string | Buffer | undefined, ...args: string[]) =>
  execFileSync("git", args, { stdio: "pipe", input, env: { ...process.env, ...env } }).toString().trim();
const AUTHOR = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@x",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@x",
};

export interface RepoWorld {
  /** The directory `setRemoteBaseForTests` is given (as `file://<dir>`). */
  dir: string;
  /** GitHub's id of each organization, by login. */
  orgIds: Record<string, number>;
  /** GitHub's id of each repository, by `org/name`. */
  ids: Map<string, number>;
  /** Owners GitHub reports for a repository other than its organization: a transferred one. */
  foreignOwner: Set<string>;
  /** Repositories GitHub reports public. */
  publicRepos: Set<string>;
  /** While true, a repository the App creates refuses every push. */
  refusePushes: boolean;
  /** While true, a push to a repository the App creates waits for {@link release}. */
  stallPushes: boolean;
  /** Ends the stalled pushes: accepted (`ok`), or refused. */
  release: (ok: boolean) => void;
  /** While true, GitHub serves no ruleset: the free plan's 403 "Upgrade to GitHub Pro". */
  freePlan: boolean;
  /** The rulesets of each repository, by `org/name`. */
  rulesets: Map<string, { id: number; name: string }[]>;
  /** The archived repositories (M3-05a): read-only until a `PATCH` un-archives them. */
  archived: Set<string>;
  /** The collaborators of each repository, by `org/name`: login → permission. */
  collaborators: Map<string, Map<string, string>>;
  /** Logins GitHub refuses to invite (an account renamed away): the 403 of the collaborators endpoint. */
  uninvitable: Set<string>;
  /** The pending invitations of each repository, by `org/name`: invitation id → login. Accepted once removed from here. */
  invitations: Map<string, Map<number, string>>;
  /** Repositories, by `org/name`, that refuse every collaborator removal (a 403). */
  unrevokable: Set<string>;
  /** A repository with commits on `branches` (`file` → content), as a teacher pushed it. */
  source: (org: string, name: string, branches: Record<string, Record<string, string>>, commits?: number) => void;
  /** The empty repository `org/name`, as a failed build leaves it. */
  empty: (org: string, name: string) => void;
  /** Lets every repository refused or stalled so far take pushes again. */
  allowPushes: () => void;
  exists: (fullName: string) => boolean;
  /** `git` on a bare repository of the world. */
  git: (fullName: string, ...args: string[]) => string;
  /**
   * A commit on `branch` of `fullName` changing `files` (content, or null
   * to delete), as a student or a workflow pushes it; its sha.
   */
  commit: (fullName: string, branch: string, files: Record<string, string | null>) => string;
  /** The content of `path` at `ref`, or null when there is none. */
  read: (fullName: string, ref: string, path: string) => string | null;
  remove: () => void;
  route: Route;
}

/** GitHub Free's answer to a ruleset on a private repository. */
const planRefusal = () => json({ message: "Upgrade to GitHub Pro or make this repository public to enable this feature." }, 403);

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
  /** HEAD's branch when it exists (a `PATCH` moves it), else `main`, else the first. */
  const defaultOf = (fullName: string) => {
    const branches = branchesOf(fullName);
    const head = sh("--git-dir", pathOf(fullName), "symbolic-ref", "--short", "HEAD").trim();
    if (branches.includes(head)) return head;
    return branches.includes("main") ? "main" : (branches[0] ?? "main");
  };
  let nextIndex = 0;
  /** A tree: `base`'s (none: empty) with `entries` set (a blob's sha) or removed (null). */
  const buildTree = (fullName: string, base: string | null, entries: { path: string; sha: string | null }[]) => {
    const env = { GIT_INDEX_FILE: join(dir, `index-${nextIndex++}`) };
    const git = (...args: string[]) => shWith(env, undefined, "--git-dir", pathOf(fullName), ...args);
    try {
      if (base) git("read-tree", base);
      else git("read-tree", "--empty");
      // Mode 0 removes a path: `--index-info` needs no work tree.
      const info = entries.map((e) => (e.sha ? `100644 ${e.sha}\t${e.path}` : `0 ${"0".repeat(40)}\t${e.path}`));
      if (info.length > 0) shWith(env, `${info.join("\n")}\n`, "--git-dir", pathOf(fullName), "update-index", "--index-info");
      return git("write-tree");
    } finally {
      rmSync(env.GIT_INDEX_FILE, { force: true });
    }
  };
  const writeBlob = (fullName: string, bytes: Buffer) =>
    shWith({}, bytes, "--git-dir", pathOf(fullName), "hash-object", "-w", "--stdin");
  const commitTree = (fullName: string, tree: string, parents: string[], message: string) =>
    shWith(AUTHOR, message, "--git-dir", pathOf(fullName), "commit-tree", tree, ...parents.flatMap((p) => ["-p", p]));
  /** `path`'s blob sha at `ref`, or null. */
  const blobOf = (fullName: string, ref: string, path: string) => {
    const line = sh("--git-dir", pathOf(fullName), "ls-tree", ref, "--", path).trim();
    const [meta] = line.split("\t");
    return line && meta!.split(" ")[1] === "blob" ? meta!.split(" ")[2]! : null;
  };
  const repoJson = (org: string, name: string) => ({
    id: world.ids.get(`${org}/${name}`),
    name,
    full_name: `${org}/${name}`,
    private: !world.publicRepos.has(`${org}/${name}`),
    archived: world.archived.has(`${org}/${name}`),
    default_branch: world.exists(`${org}/${name}`) ? defaultOf(`${org}/${name}`) : "main",
    pushed_at: "2026-09-30T08:00:00Z",
    owner: { login: org, id: world.foreignOwner.has(`${org}/${name}`) ? 999_999 : (world.orgIds[org] ?? 0) },
  });

  let nextRuleset = 1;
  let nextInvitation = 1;
  /** A write on an existing repository: its default branch, a ruleset, an invitation. */
  const repoWrite = (org: string, name: string, rest: string, req: RequestInit & { method: string }): Response | undefined => {
    const fullName = `${org}/${name}`;
    let m: RegExpExecArray | null;
    if (req.method === "PATCH" && rest === "") {
      const { default_branch, archived } = JSON.parse(String(req.body)) as { default_branch?: string; archived?: boolean };
      if (default_branch) world.git(fullName, "symbolic-ref", "HEAD", `refs/heads/${default_branch}`);
      if (archived === true) world.archived.add(fullName);
      if (archived === false) world.archived.delete(fullName);
      return json(repoJson(org, name));
    }
    // An archived repository takes no write but its un-archiving (GitHub's 403).
    if (world.archived.has(fullName)) return json({ message: "Repository was archived so is read-only." }, 403);
    if (req.method === "DELETE" && (m = /^\/rulesets\/(\d+)$/.exec(rest))) {
      const id = Number(m[1]);
      world.rulesets.set(fullName, (world.rulesets.get(fullName) ?? []).filter((r) => r.id !== id));
      return new Response(null, { status: 204 });
    }
    const body = () => JSON.parse(String(req.body)) as Record<string, unknown>;
    if (req.method === "POST" && rest === "/git/blobs") {
      const { content, encoding } = body() as { content: string; encoding: string };
      return json({ sha: writeBlob(fullName, Buffer.from(content, encoding === "base64" ? "base64" : "utf8")) }, 201);
    }
    if (req.method === "POST" && rest === "/git/trees") {
      const { base_tree, tree } = body() as { base_tree?: string; tree: { path: string; sha: string | null }[] };
      return json({ sha: buildTree(fullName, base_tree ?? null, tree) }, 201);
    }
    if (req.method === "POST" && rest === "/git/commits") {
      const { tree, parents, message } = body() as { tree: string; parents: string[]; message: string };
      return json({ sha: commitTree(fullName, tree, parents, message) }, 201);
    }
    if (req.method === "PATCH" && (m = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const { sha, force } = body() as { sha: string; force?: boolean };
      const current = world.git(fullName, "rev-parse", `refs/heads/${m[1]}`).trim();
      try {
        if (!force) world.git(fullName, "merge-base", "--is-ancestor", current, sha);
      } catch {
        return json({ message: "Update is not a fast forward" }, 422);
      }
      world.git(fullName, "update-ref", `refs/heads/${m[1]}`, sha);
      return json({ ref: `refs/heads/${m[1]}`, object: { sha } });
    }
    if (req.method === "POST" && rest === "/rulesets") {
      if (world.freePlan) return planRefusal();
      const { name } = JSON.parse(String(req.body)) as { name: string };
      const ruleset = { id: nextRuleset++, name };
      world.rulesets.set(fullName, [...(world.rulesets.get(fullName) ?? []), ruleset]);
      return json(ruleset, 201);
    }
    if (req.method === "PUT" && (m = /^\/collaborators\/([^/]+)$/.exec(rest))) {
      const login = m[1]!;
      if (world.uninvitable.has(login)) return json({ message: "Resource not accessible by integration" }, 403);
      const seats = world.collaborators.get(fullName) ?? new Map<string, string>();
      world.collaborators.set(fullName, seats);
      const invited = seats.has(login);
      seats.set(login, (JSON.parse(String(req.body)) as { permission: string }).permission);
      if (invited) return new Response(null, { status: 204 });
      const id = nextInvitation++;
      const pending = world.invitations.get(fullName) ?? new Map<number, string>();
      world.invitations.set(fullName, pending);
      pending.set(id, login);
      return json({ id, invitee: { login } }, 201);
    }
    // A collaborator removed (GitHub: a pending invitation is not one, 404), or an invitation cancelled.
    if (req.method === "DELETE" && (m = /^\/collaborators\/([^/]+)$/.exec(rest))) {
      if (world.unrevokable.has(fullName)) return json({ message: "Must have admin rights to Repository." }, 403);
      const login = m[1]!;
      const pending = [...(world.invitations.get(fullName)?.values() ?? [])].includes(login);
      if (pending || !world.collaborators.get(fullName)?.delete(login)) return json({ message: "Not Found" }, 404);
      return new Response(null, { status: 204 });
    }
    if (req.method === "DELETE" && (m = /^\/invitations\/(\d+)$/.exec(rest))) {
      const pending = world.invitations.get(fullName);
      const login = pending?.get(Number(m[1]));
      if (login === undefined) return json({ message: "Not Found" }, 404);
      pending!.delete(Number(m[1]));
      world.collaborators.get(fullName)?.delete(login);
      return new Response(null, { status: 204 });
    }
    return undefined;
  };

  const world: RepoWorld = {
    dir,
    orgIds: {},
    ids: new Map(),
    foreignOwner: new Set(),
    publicRepos: new Set(),
    refusePushes: false,
    stallPushes: false,
    freePlan: false,
    rulesets: new Map(),
    archived: new Set(),
    collaborators: new Map(),
    uninvitable: new Set(),
    invitations: new Map(),
    unrevokable: new Set(),
    release(ok) {
      writeFileSync(join(dir, "release"), ok ? "0" : "1");
    },
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
      rmSync(join(dir, "release"), { force: true });
      world.refusePushes = false;
      world.stallPushes = false;
    },
    exists: (fullName) => existsSync(pathOf(fullName)),
    git: (fullName, ...args) => sh("--git-dir", pathOf(fullName), ...args),
    commit(fullName, branch, files) {
      const head = world.git(fullName, "rev-parse", `refs/heads/${branch}`).trim();
      const entries = Object.entries(files).map(([path, content]) => ({
        path,
        sha: content === null ? null : writeBlob(fullName, Buffer.from(content)),
      }));
      const sha = commitTree(fullName, buildTree(fullName, head, entries), [head], "work");
      world.git(fullName, "update-ref", `refs/heads/${branch}`, sha);
      return sha;
    },
    read(fullName, ref, path) {
      const sha = blobOf(fullName, ref, path);
      return sha ? world.git(fullName, "cat-file", "blob", sha) : null;
    },
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
        if (world.refusePushes || world.stallPushes) {
          const hook = join(pathOf(fullName), "hooks", "pre-receive");
          const release = join(dir, "release");
          writeFileSync(
            hook,
            world.refusePushes
              ? "#!/bin/sh\necho refused >&2\nexit 1\n"
              : `#!/bin/sh\nwhile [ ! -f "${release}" ]; do sleep 0.05; done\nexit $(cat "${release}")\n`,
          );
          chmodSync(hook, 0o755);
          refusing.push(hook);
        }
        return json(repoJson(org, name), 201);
      }
      if ((m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path)) && req.method !== "GET" && world.exists(`${m[1]}/${m[2]}`)) {
        return repoWrite(m[1]!, m[2]!, m[3] ?? "", req);
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
      if ((m = /^\/git\/matching-refs\/heads\/(.+)$/.exec(rest))) {
        if (branches.length === 0) return json({ message: "Git Repository is empty." }, 409);
        return json(branches.filter((b) => b === m![1]).map((b) => ({ ref: `refs/heads/${b}` })));
      }
      if (rest === "/rulesets") return world.freePlan ? planRefusal() : json(world.rulesets.get(fullName) ?? []);
      if (rest === "/invitations") {
        return json([...(world.invitations.get(fullName) ?? new Map<number, string>())].map(([id, login]) => ({ id, invitee: { login } })));
      }
      if ((m = /^\/contents\/(.+)$/.exec(rest))) {
        const sha = blobOf(fullName, url.searchParams.get("ref") ?? "HEAD", m[1]!);
        if (!sha) return undefined;
        const content = execFileSync("git", ["--git-dir", join(dir, `${fullName}.git`), "cat-file", "blob", sha]).toString("base64");
        return json({ type: "file", path: m[1], sha, content, encoding: "base64" });
      }
      if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
        if (!branches.includes(m[1]!)) return undefined;
        return json({ ref: `refs/heads/${m[1]}`, object: { sha: world.git(fullName, "rev-parse", m[1]!).trim() } });
      }
      if ((m = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest))) {
        return json({ sha: m[1], tree: { sha: world.git(fullName, "rev-parse", `${m[1]}^{tree}`).trim() } });
      }
      if ((m = /^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(rest))) {
        const base = world.git(fullName, "merge-base", m[1]!, m[2]!).trim();
        const files = world
          .git(fullName, "diff", "--name-only", "--no-renames", base, m[2]!)
          .split("\n")
          .filter(Boolean)
          .map((filename) => ({ filename, status: "modified" }));
        return json({ files });
      }
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
