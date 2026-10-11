/**
 * Seeding of the `<vol>/work` workspace: a clone of the staging repository,
 * with `origin` pointed at the portal's Git channel.
 *
 * **Timing matters.** This function runs *before* the `podman run`: after it,
 * the `:U` option has given `work/` to the UID range that `--userns=auto` drew
 * for the container, and the portal (uid `codespace`) can no longer create or
 * modify a file there. This is the same constraint as the one described in
 * `shadow.ts`, seen from the write side.
 *
 * Consequence carried by `manager.ts`: the session id is **stable for the
 * lifetime of the volume**, because the `origin` remote written here contains
 * it and it will never be rewritten.
 *
 * **The host never reads nor runs git on a `.git` it did not create**
 * (audit L23). A `.git` in `work/` may be the student's: its config
 * (`core.fsmonitor`, `include.path`, a remote's `uploadpack`), its hooks, its
 * `alternates` or a symlink under it would run code, or read files, as the
 * portal. So the host looks at one thing, whether `work/.git` exists
 * ({@link inspectWorkspace}, an `lstat`), and:
 *
 *  - `work/.git` absent, in a `work/` the portal owns and nobody else may
 *    write → full seeding from the host, in the repository this call creates;
 *  - anything else (a `.git` of any kind, or a `work/` already the
 *    container's) → `manager.ts` plays {@link completionScript} through
 *    `engine.exec` after the start, as the student. The script leaves a
 *    repository that has a commit alone (the student owns it), creates one
 *    if there is none, and completes an unborn one — the 2026-09-17 case, a
 *    staging repository empty at the first start: fetch, local branch on the
 *    default branch, tracking `origin/<branch>`, the student's untracked
 *    files kept.
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
 * Git on the repository this call has just created in a `work/` the portal
 * owns, and on no other. `safe.directory` is set on the call itself, `HOME`
 * being neutralised by `gitRunner`; hooks and fsmonitor off are a belt: the
 * repository has neither.
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
    { env: IDENTITY },
  );
}

export interface WorkspaceState {
  /** `work/.git` exists, whatever it is (never followed). */
  present: boolean;
  /**
   * `work/` is a directory the portal's uid owns, writable by it and by no
   * group nor other: nobody else can put a `.git` there between this look
   * and the host's `git init` (audit L23). False once `:U` has given it to
   * the container.
   */
  owned: boolean;
}

/** Whether `dir` itself (not a symlink) is the portal's alone. */
async function portalOwned(dir: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const { uid, mode } = await handle.stat();
    return uid === process.getuid?.() && (mode & 0o200) !== 0 && (mode & 0o022) === 0;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * What the host knows of `work/`, without reading anything of a `.git` in
 * it: whether one exists (`lstat`, a symlink counts and is not followed),
 * and whether `work/` is the portal's alone.
 */
export async function inspectWorkspace(workDir: string): Promise<WorkspaceState> {
  const present = (await lstat(join(workDir, ".git")).catch(() => null)) !== null;
  return { present, owned: await portalOwned(workDir) };
}

/** An arbitrary value, made harmless for `sh -lc`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Sets `user.name` / `user.email` in `work/.git/config` of the repository this
 * call has just created; an existing one gets {@link identityScript}.
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
 * The same thing, played **inside the container** in a repository the host
 * did not create. No secret gets in: a name and an academic address.
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
 * Completion script, played **inside the container**, as the student, in any
 * workspace the host did not seed itself:
 *
 *  - a repository with a commit is the student's: the script exits at once;
 *  - no repository: one is created, `origin` set to the portal's channel;
 *  - `fetch origin` goes through `http://portal.internal:9418/git/<session>`,
 *    which the source IP address authenticates: **no secret enters the
 *    container** (invariant 1);
 *  - `checkout -B` from an unborn branch keeps the untracked files the student
 *    has already written; it refuses rather than overwriting an untracked file
 *    the repository brings, and the message says so;
 *  - `--set-upstream-to` makes argument-less `git pull` and `git push` correct.
 *
 * `branch` null: the staging repository has no branch yet, nothing to fetch.
 */
export function completionScript(origin: string, branch: string | null): string {
  const lines = [
    "set -e",
    "cd /work",
    "git rev-parse -q --verify HEAD >/dev/null 2>&1 && exit 0",
    "git rev-parse --git-dir >/dev/null 2>&1 || git init -q --initial-branch=main",
    `git remote get-url origin >/dev/null 2>&1 || git remote add origin ${shellQuote(origin)}`,
  ];
  if (branch === null) return lines.join("\n");
  const b = shellQuote(branch);
  const tracking = shellQuote(`origin/${branch}`);
  return [
    ...lines,
    "git fetch -q origin '+refs/heads/*:refs/remotes/origin/*'",
    `git checkout -q -B ${b} ${tracking}`,
    `git branch -q --set-upstream-to=${tracking} ${b}`,
    "git --no-pager log --oneline -1",
  ].join("\n");
}

export interface EnsureWorkspaceResult {
  /** `work/.git` was created by this call. */
  created: boolean;
  /** Local branch set, or to set: the staging repository's. `null`: it is empty. */
  branch: string | null;
  /**
   * The host did not seed the workspace (a `.git` was there, or `work/` is no
   * longer the portal's alone): `manager.ts` plays {@link completionScript}
   * through `engine.exec` after the start.
   */
  needsContainer: boolean;
  /**
   * The git identity is still to be set, for the same reason. `manager.ts`
   * then plays `identityScript` through `engine.exec`.
   */
  needsIdentity: boolean;
}

export async function ensureWorkspace(opts: WorkspaceOptions): Promise<EnsureWorkspaceResult> {
  const work = opts.paths.workDir;
  const origin = remoteUrl(opts.gitRemoteHost, opts.gitRemotePort, opts.sessionId);
  const state = await inspectWorkspace(work);
  const branch = await stagingHeadBranch(opts.paths.gitDir);

  if (state.present || !state.owned) {
    // Possibly the student's: everything is done in the container (audit
    // L23), including the identity, which depends neither on the commits
    // nor on the branch.
    return { created: false, branch, needsContainer: true, needsIdentity: opts.identity !== undefined };
  }

  await git(["init", "-q", "--initial-branch=main", work], { env: IDENTITY });
  await git(["-C", work, "remote", "add", "origin", origin], { env: IDENTITY });
  if (opts.identity) await writeIdentity(work, opts.identity);
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
