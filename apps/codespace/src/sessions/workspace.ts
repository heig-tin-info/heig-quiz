/**
 * Seeding of the `<vol>/work` workspace: a clone of the staging repository,
 * with `origin` pointed at the portal's Git channel.
 *
 * **Timing matters.** This function runs *before* the `podman run`: after it,
 * the `:U` option has given `work/` to the UID range that `--userns=auto` drew
 * for the container, and the portal (uid `codespace`) can no longer create or
 * modify a file there — in particular not `work/.git/config`. This is the same
 * constraint as the one described in `shadow.ts`, seen from the write side.
 *
 * Consequence carried by `manager.ts`: the session id is **stable for the
 * lifetime of the volume**, because the `origin` remote written here contains
 * it and it will never be rewritten.
 *
 * Three states are distinguished, and that is the 2026-09-17 fix:
 *
 *  - `work/.git` absent → full seeding from the staging repository, from the
 *    host, in a repository the portal has just created;
 *  - `work/.git` present but **with no commit at all** (the case of a session
 *    whose staging repository was empty at the first start, for lack of a token
 *    to fetch the student's private repository) → it is completed **inside the
 *    container**: `manager.ts` plays `completionScript` through `engine.exec`
 *    after the start — fetch, local branch on the default branch, tracking
 *    `origin/<branch>`. The untracked files the student has already created
 *    are kept: `checkout -B` from an unborn branch does not touch them;
 *  - `work/.git` with at least one commit is **never** touched again: the
 *    student owns their repository.
 *
 * **The portal never runs git on a `.git` it did not create in this call**
 * (audit L23): a `.git` in `work/` may be the student's, and its config
 * (`core.fsmonitor`, `include.path`, a remote's `uploadpack`), its hooks or
 * its `alternates` would run code, or read files, as the portal. What the
 * portal needs to know of an existing one — present, born, branch — it reads
 * as plain files ({@link inspectWorkspace}); what must be done in it is done
 * in the container, as the student.
 */
import { constants, lstat, open } from "node:fs/promises";
import { join } from "node:path";

import { git, stagingHeadBranch, type StagingPaths } from "../git/index.js";

const IDENTITY = {
  GIT_AUTHOR_NAME: "codespace-portal",
  GIT_AUTHOR_EMAIL: "portal@codespace.local",
  GIT_COMMITTER_NAME: "codespace-portal",
  GIT_COMMITTER_EMAIL: "portal@codespace.local",
} as const;

/**
 * The student's git identity, as the `users` table knows it (`display_name`,
 * `email`). It is not a secret: it is the name and the academic address the
 * student already reads in classroom.
 */
export interface GitIdentity {
  name: string;
  email: string;
}

export interface WorkspaceOptions {
  paths: StagingPaths;
  sessionId: string;
  /** `portal.internal`: the name `--add-host` gives to the gateway. */
  gitRemoteHost: string;
  gitRemotePort: number;
  /**
   * Identity to write into `work/.git/config` if it is not there already. The
   * container's `GIT_AUTHOR_*` / `GIT_COMMITTER_*` variables are enough for
   * `git commit`, but the student who types `git config user.name` must read
   * something, and an identity set by the student themselves is never
   * overwritten.
   */
  identity?: GitIdentity;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export function remoteUrl(host: string, port: number, sessionId: string): string {
  return `http://${host}:${port}/git/${sessionId}`;
}

/**
 * Git on the repository this call has just created in `work/`, and on no
 * other. Hardened all the same: no system nor global configuration, no
 * hooks, no fsmonitor. `safe.directory` is set on the call itself, `HOME`
 * being neutralised by `gitRunner`.
 */
function gitWork(workDir: string, args: string[]): Promise<string> {
  return git(
    [
      "-c",
      `safe.directory=${workDir}`,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-C",
      workDir,
      ...args,
    ],
    { env: { ...IDENTITY, GIT_CONFIG_GLOBAL: "/dev/null" } },
  );
}

export interface WorkspaceState {
  /** `work/.git` exists, whatever it is. */
  present: boolean;
  /**
   * `HEAD` points at a commit — or the portal cannot tell, from a `.git` it
   * cannot read as a plain repository (a symlink, a `gitdir:` file, a
   * reftable, an unreadable or odd `HEAD`): either way the workspace is the
   * student's and is left alone. False only for a branch read as unborn.
   */
  born: boolean;
  /** Current branch, even unborn; null when detached or unreadable. */
  branch: string | null;
}

/** The longest `HEAD` or loose ref read; a real one is under 300 bytes. */
const MAX_REF_BYTES = 4096;
/** The longest `packed-refs` read: past it, the portal does not judge. */
const MAX_PACKED_REFS_BYTES = 1 << 20;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * A file of the student's `.git`, read as bytes and nothing else: never
 * through a final symlink (`O_NOFOLLOW`), never blocking on a FIFO
 * (`O_NONBLOCK`), only a regular file of at most `max` bytes. Null otherwise.
 */
async function readPlainFile(path: string, max: number): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) return null;
    return (await handle.readFile()).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * A branch name that names a file under `refs/heads/` and nothing above it:
 * no empty, `.`-led or `..` segment, no control character nor backslash.
 */
function plainBranch(name: string): boolean {
  return (
    name !== "" &&
    !/[\x00-\x20\x7f\\~^:?*[]/.test(name) &&
    name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

/**
 * What the portal knows of `work/`, read as plain files, **without running
 * git on it** (audit L23): `work/.git` must be a real directory, `HEAD` a
 * regular file naming a branch or a commit, the branch's loose ref or its
 * `packed-refs` line a commit id. Whatever does not fit is reported as
 * born: the portal does not judge it, and does not touch it.
 */
export async function inspectWorkspace(workDir: string): Promise<WorkspaceState> {
  const dotGit = join(workDir, ".git");
  const kind = await lstat(dotGit).catch(() => null);
  if (kind === null) return { present: false, born: false, branch: null };
  const theStudents = { present: true, born: true, branch: null };
  if (!kind.isDirectory()) return theStudents;
  const head = (await readPlainFile(join(dotGit, "HEAD"), MAX_REF_BYTES))?.trim();
  if (head === undefined) return theStudents;
  if (OBJECT_ID.test(head)) return theStudents; // detached: on a commit
  const ref = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1];
  if (ref === undefined || !plainBranch(ref)) return theStudents;
  const loose = (await readPlainFile(join(dotGit, "refs", "heads", ...ref.split("/")), MAX_REF_BYTES))?.trim();
  const packed = await readPlainFile(join(dotGit, "packed-refs"), MAX_PACKED_REFS_BYTES);
  const inPacked = (packed ?? "")
    .split("\n")
    .some((line) => line.endsWith(` refs/heads/${ref}`) && OBJECT_ID.test(line.slice(0, line.indexOf(" "))));
  return { present: true, born: (loose !== undefined && OBJECT_ID.test(loose)) || inPacked, branch: ref };
}

/** An arbitrary value, made harmless for `sh -lc`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Sets `user.name` / `user.email` in `work/.git/config`, **never overwriting**
 * what is already there. Called from the host on the repository this call has
 * just created only; an existing one gets {@link identityScript}.
 */
async function writeIdentity(workDir: string, identity: GitIdentity): Promise<void> {
  const present = async (key: string): Promise<boolean> =>
    (await gitWork(workDir, ["config", "--local", "--get", key]).catch(() => "")).trim() !== "";
  if (!(await present("user.name"))) {
    await gitWork(workDir, ["config", "--local", "user.name", identity.name]);
  }
  if (!(await present("user.email"))) {
    await gitWork(workDir, ["config", "--local", "user.email", identity.email]);
  }
}

/**
 * The same thing, played **inside the container** when `work/` no longer
 * belongs to us. No secret gets in: a name and an academic address.
 *
 * The script exits without doing anything when `/work` is not a repository —
 * the case of an assignment without a staging repository — and touches nothing
 * when the student has already set their identity.
 */
export function identityScript(identity: GitIdentity): string {
  const name = shellQuote(identity.name);
  const email = shellQuote(identity.email);
  return [
    "set -e",
    "cd /work",
    "git rev-parse --git-dir >/dev/null 2>&1 || exit 0",
    `git config --local --get user.name >/dev/null 2>&1 || git config --local user.name ${name}`,
    `git config --local --get user.email >/dev/null 2>&1 || git config --local user.email ${email}`,
    "git config --local --get user.name",
    "git config --local --get user.email",
  ].join("\n");
}

/**
 * Completion script, played **inside the container** when `work/` no longer
 * belongs to us. It does what `ensureWorkspace` does from the host, with the
 * same guarantees:
 *
 *  - `fetch origin` goes through `http://portal.internal:9418/git/<session>`,
 *    which the source IP address authenticates: **no secret enters the
 *    container** (invariant 1);
 *  - `checkout -B` from an unborn branch keeps the untracked files the student
 *    has already written; it refuses rather than overwriting an untracked file
 *    the repository brings, and the message says so;
 *  - `--set-upstream-to` makes argument-less `git pull` and `git push` correct.
 */
export function completionScript(branch: string): string {
  return [
    "set -e",
    "cd /work",
    "git fetch -q origin '+refs/heads/*:refs/remotes/origin/*'",
    `git checkout -q -B '${branch}' 'origin/${branch}'`,
    `git branch -q --set-upstream-to='origin/${branch}' '${branch}'`,
    "git --no-pager log --oneline -1",
  ].join("\n");
}

export interface EnsureWorkspaceResult {
  /** `work/.git` was created by this call. */
  created: boolean;
  /** Local branch set, with tracking. `null`: the staging repository is empty. */
  branch: string | null;
  /**
   * An existing repository without a commit is still to be completed, which
   * the host never does in a `.git` it did not create (audit L23).
   * `manager.ts` picks it up through `engine.exec` after the start.
   */
  needsContainer: boolean;
  /**
   * The git identity is still to be set in an existing repository, for the
   * same reason. `manager.ts` then plays `identityScript` through
   * `engine.exec`.
   */
  needsIdentity: boolean;
}

export async function ensureWorkspace(opts: WorkspaceOptions): Promise<EnsureWorkspaceResult> {
  const work = opts.paths.workDir;
  const origin = remoteUrl(opts.gitRemoteHost, opts.gitRemotePort, opts.sessionId);
  const state = await inspectWorkspace(work);

  if (state.present) {
    // An existing repository may be the student's: everything is done in the
    // container (audit L23). The identity depends neither on the commits nor
    // on the branch: a student whose workspace is complete must be able to
    // commit, and that is precisely the case observed in production.
    const needsIdentity = opts.identity !== undefined;
    // A repository that carries commits belongs to the student: left alone.
    if (state.born) {
      return { created: false, branch: state.branch, needsContainer: false, needsIdentity };
    }
    // Staging repository still without a ref (empty target repository in lab
    // mode): nothing to set, the workspace stays the student's.
    const branch = await stagingHeadBranch(opts.paths.gitDir);
    return { created: false, branch, needsContainer: branch !== null, needsIdentity };
  }

  await git(["init", "-q", "--initial-branch=main", work], { env: IDENTITY });
  await git(["-C", work, "remote", "add", "origin", origin], { env: IDENTITY });
  if (opts.identity) await writeIdentity(work, opts.identity);
  const branch = await stagingHeadBranch(opts.paths.gitDir);
  // The content comes from the staging repository through the local path: the
  // portal has no reason to go through its own HTTP server to talk to itself.
  await gitWork(work, [
    "fetch",
    "-q",
    opts.paths.gitDir,
    "+refs/heads/*:refs/remotes/origin/*",
  ]).catch(() => "");
  const branches = (
    await gitWork(work, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/remotes/origin/",
    ]).catch(() => "")
  )
    .split("\n")
    .filter(Boolean);
  // The staging repository's default branch first — it is the student
  // repository's own, `master` as often as `main` — then `origin/main`, then
  // the first one that comes.
  const preferred =
    branch && branches.includes(`origin/${branch}`)
      ? `origin/${branch}`
      : branches.includes("origin/main")
        ? "origin/main"
        : branches[0];
  let local: string | null = null;
  if (preferred) {
    local = preferred.replace(/^origin\//, "");
    await gitWork(work, ["checkout", "-q", "-B", local, preferred]);
    // Tracking is what makes argument-less `git pull` and `git push` correct
    // inside the container; without it, the student has to name their remote and
    // their branch every time.
    await gitWork(work, ["branch", "-q", `--set-upstream-to=${preferred}`, local]).catch(() => "");
  }
  opts.log?.info({ sessionId: opts.sessionId, origin, branch: local }, "workspace seeded");
  return { created: true, branch: local, needsContainer: false, needsIdentity: false };
}
