/**
 * Host-side shadow repository (analyse.md § 3.3, safety net E15).
 *
 * `git --git-dir=<vol>/shadow.git --work-tree=<vol>/work add -A && commit`,
 * every three minutes and one last time when the session closes.
 * It captures the working tree including what the student has not committed,
 * without ever touching their repository or showing up in the container.
 *
 * ## Nested repositories (audit L23, `CLAUDE.md` invariant 13)
 *
 * The host never reads nor runs git on a `.git` it did not create. `git add`
 * does both when it meets a directory holding a `.git` entry: it treats the
 * directory as an embedded repository, follows the entry (a directory, a
 * gitfile `gitdir: <any path>` or a symbolic link) and reads that
 * repository's `HEAD` to record a gitlink. So before each `add`, the
 * snapshot writes `info/exclude` afresh ({@link snapshotExcludes}): `.git`,
 * the student's own repository at the top of `work/`, then every directory
 * under `work/` that holds a `.git` entry of any kind, at any depth, as an
 * anchored pattern. git checks the exclusion before it probes a directory,
 * so it never opens those entries. The walk that finds them only lists
 * directories (`readdir`'s types, `lstat` when the type is unknown): it
 * never follows a link, never opens a `.git` and never descends into one.
 * The student's ordinary files are captured; the files under a directory
 * that is itself a nested repository are not (before this exclusion the
 * gitlink captured none of them either). `deploy/shadow-snapshot.sh`, the
 * root timer, applies the same rule with `find`.
 *
 * What this guarantees, and what it does not. A `.git` entry present when
 * the walk lists its parent, and still there when `git add` reaches it, is
 * never opened. One created in a directory after the walk listed it and
 * before `git add` lists it — a student process creating and removing the
 * entry in a loop can win that window now and then — is still probed once by
 * git: a read-only look at the pointed-at path (`objects`, `refs`, `HEAD`),
 * as this process, and a gitlink may be staged, which the collection leaves
 * out (`composeCollectionTree`) and which captures nothing. No check made
 * before `git add` can close that window on a tree the student writes
 * while it runs: only a frozen tree or a git that cannot reach outside the
 * volume could.
 *
 * ## The permissions question, and what is done about it here
 *
 * The volume is mounted `:U` (analyse.md D6): Podman rechowns `work/` to the
 * UID range that `--userns=auto` drew for this container, for example
 * 2147484647. The portal runs as uid 1000. **Measured on this machine**: the
 * modes are preserved by the chown, the container's umask is 022, so files
 * stay at 644 and directories at 755 — uid 1000 can read them, and the
 * snapshot works.
 *
 * What does not work: a `chmod 600` by the student. The file becomes
 * unreadable for the portal, `git add -A` answers
 * `error: open("x"): Permission denied` and exits with 128. `--ignore-errors`
 * turns the total failure into a partial snapshot, and that is what this
 * module does, logging every file lost.
 *
 * This is **not** a solution, it is a mitigation. The production solution, to
 * be worked out at milestone 1, is one of these two:
 *
 *  - a per-session fixed `--uidmap` instead of `--userns=auto`: the portal then
 *    knows the container's host UID and can set an ACL
 *    (`setfacl -R -m u:1000:rX`) inherited by default on `work/`;
 *  - a **root** systemd timer on the host that takes the snapshot, the portal
 *    only telling it which volumes are active.
 *
 * What must above all not be done, and is not done: removing `:U`. Without it
 * the student can no longer write into their own volume.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { git, gitBare } from "../git/index.js";

export interface ShadowResult {
  /** Sha of the commit created, or null if the tree had not moved. */
  sha: string | null;
  /** Paths the portal could not read (see the module header). */
  unreadable: string[];
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "codespace-portal",
  GIT_AUTHOR_EMAIL: "portal@codespace.local",
  GIT_COMMITTER_NAME: "codespace-portal",
  GIT_COMMITTER_EMAIL: "portal@codespace.local",
} as const;

/** `<vol>/shadow.git`, created if needed, with its `info/` directory. */
export async function ensureShadowRepo(volumeDir: string): Promise<string> {
  const gitDir = join(volumeDir, "shadow.git");
  try {
    await gitBare(gitDir, ["rev-parse", "--git-dir"]);
  } catch {
    await mkdir(gitDir, { recursive: true });
    await git(["init", "--bare", "--initial-branch=main", gitDir]);
  }
  await mkdir(join(gitDir, "info"), { recursive: true });
  return gitDir;
}

const DOT_GIT = Buffer.from(".git");
const SLASH = 0x2f;
/** What a gitignore pattern reads as a wildcard, an escape, a negation, a comment or trimmable space. */
const SPECIAL = new Set([..."\\*?[]!# "].map((c) => c.charCodeAt(0)));

/**
 * One anchored, directory-only exclusion line for `rel` (bytes relative to
 * `work/`): every special character escaped; a control character, which no
 * line can hold (a newline in a name), becomes `?`, which matches it — and
 * any other single byte there: such an exclusion can only be wider.
 * `deploy/shadow-snapshot.sh` writes the same lines with `sed` and `tr`.
 */
export function excludeLine(rel: Buffer): Buffer {
  const out: number[] = [SLASH];
  for (const byte of rel) {
    if (byte < 0x20 || byte === 0x7f) out.push(0x3f);
    else {
      if (SPECIAL.has(byte)) out.push(0x5c);
      out.push(byte);
    }
  }
  out.push(SLASH, 0x0a);
  return Buffer.from(out);
}

/**
 * The snapshot's `info/exclude` (module header, Nested repositories): `.git`,
 * then every directory under `workTree` that holds a `.git` entry of any
 * kind, found by listing directories only. Names stay bytes, never decoded:
 * a pattern must match the name on disk. A directory that cannot be listed
 * is skipped: git cannot list it either.
 */
export async function snapshotExcludes(workTree: string): Promise<Buffer> {
  const lines: Buffer[] = [Buffer.from(".git\n")];
  const root = Buffer.from(workTree);
  const pending: Buffer[] = [Buffer.alloc(0)];
  for (let rel = pending.pop(); rel !== undefined; rel = pending.pop()) {
    const dir = rel.length === 0 ? root : Buffer.concat([root, Buffer.of(SLASH), rel]);
    const entries = await readdir(dir, { withFileTypes: true, encoding: "buffer" }).catch(() => []);
    if (rel.length > 0 && entries.some((e) => DOT_GIT.equals(e.name))) {
      // Excluded whole: git never looks inside it, so neither does this walk.
      lines.push(excludeLine(rel));
      continue;
    }
    for (const e of entries) {
      // `isDirectory()` is false for a symbolic link: never followed.
      if (!e.isDirectory() || DOT_GIT.equals(e.name)) continue;
      pending.push(rel.length === 0 ? e.name : Buffer.concat([rel, Buffer.of(SLASH), e.name]));
    }
  }
  return Buffer.concat(lines);
}

const UNREADABLE = /(?:error: open\("([^"]+)"\)|warning: could not open directory '([^']+)')/g;

function unreadablePaths(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(UNREADABLE)) {
    const path = m[1] ?? m[2];
    if (path) found.add(path);
  }
  return [...found];
}

/**
 * One snapshot. Idempotent: with no change, nothing is committed and `sha` is
 * null.
 */
export async function snapshot(volumeDir: string): Promise<ShadowResult> {
  const gitDir = await ensureShadowRepo(volumeDir);
  const workTree = join(volumeDir, "work");
  const common = ["--git-dir", gitDir, "--work-tree", workTree];
  // Written afresh right before the `add`: the nested repositories of now.
  await writeFile(join(gitDir, "info", "exclude"), await snapshotExcludes(workTree));

  let unreadable: string[] = [];
  try {
    await git([...common, "add", "-A", "--ignore-errors"], { env: IDENTITY });
  } catch (err) {
    // `--ignore-errors` indexes what it can then exits with 1: a partial
    // snapshot is better than no snapshot at all.
    const message = String((err as Error).message ?? err);
    unreadable = unreadablePaths(message);
    if (unreadable.length === 0) throw err;
  }

  const status = await git([...common, "status", "--porcelain=v1"], { env: IDENTITY }).catch(
    () => "",
  );
  const staged = (
    await git([...common, "diff", "--cached", "--name-only"], { env: IDENTITY }).catch(() => "")
  ).trim();
  const hasHead = await gitBare(gitDir, ["rev-parse", "--verify", "HEAD"]).then(
    () => true,
    () => false,
  );
  if (staged === "" && hasHead) return { sha: null, unreadable };
  if (staged === "" && !hasHead && status.trim() === "") return { sha: null, unreadable };

  await git(
    [...common, "commit", "--allow-empty", "-q", "-m", `snapshot ${new Date().toISOString()}`],
    { env: IDENTITY },
  );
  const sha = (await gitBare(gitDir, ["rev-parse", "HEAD"])).trim();
  return { sha, unreadable };
}
