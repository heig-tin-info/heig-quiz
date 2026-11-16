/**
 * The shadow snapshot against real repositories (audit L23, `CLAUDE.md`
 * invariant 13): a nested `.git` of any kind, at any depth, is never opened.
 *
 * The proof is a trap: a repository whose `HEAD` is a FIFO. git's probe of an
 * embedded repository opens `HEAD`, and opening a FIFO for reading blocks
 * until a writer comes; {@link watch} looks every few milliseconds for such a
 * blocked reader (a non-blocking open for writing succeeds only then), counts
 * it and releases it. `deploy/shadow-snapshot.test.sh` holds the root timer's
 * script to the same cases.
 */
import { execFile } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { git, gitBare } from "../git/index.js";
import { excludeLine, snapshot } from "./shadow.js";

const run = promisify(execFile);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "shadow-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A bare repository at `dir` whose `HEAD` is a FIFO; returns the FIFO. */
async function trap(dir: string): Promise<string> {
  await git(["init", "--bare", "-q", dir]);
  const head = join(dir, "HEAD");
  await rm(head);
  await run("mkfifo", [head]);
  return head;
}

/** Runs `task` while counting, and releasing, every reader blocked on one of `fifos`. */
async function watch<T>(fifos: string[], task: () => Promise<T>): Promise<{ result: T; opened: number }> {
  let opened = 0;
  const timer = setInterval(() => {
    for (const fifo of fifos) {
      try {
        closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
        opened += 1;
      } catch {
        // ENXIO: nobody is reading it.
      }
    }
  }, 20);
  try {
    return { result: await task(), opened };
  } finally {
    clearInterval(timer);
  }
}

/**
 * A work tree with the student's own repository at its top, ordinary files,
 * and a nested `.git` of each kind: a repository directory, a gitfile and a
 * symbolic link, at depth 1 and deeper, one under a name that needs escaping,
 * and one real clone with a commit.
 */
async function nestedWorkspace() {
  const volume = join(root, "student", "tp");
  const work = join(volume, "work");
  const outside = join(root, "elsewhere.git");
  const put = async (rel: string, text = `${rel}\n`) => {
    await mkdir(join(work, rel, ".."), { recursive: true });
    await writeFile(join(work, rel), text);
  };
  await put(".git/HEAD", "ref: refs/heads/main\n");
  await put("main.c");
  await put("a/b/kept.c");
  await put("clone2/beside.c");
  await put("clone/inside.c");
  await put("a/b/gitfile/inside.c");
  await put("link/inside.c");
  await put("a/we ird*[x]#!\nname/inside.c");
  const fifos = [
    await trap(outside),
    await trap(join(work, "clone", ".git")),
    await trap(join(work, "a", "b", "deeper", "repo", ".git")),
  ];
  await put("a/b/deeper/repo/inside.c");
  await put("a/b/gitfile/.git", `gitdir: ${outside}\n`);
  await put("a/we ird*[x]#!\nname/.git", `gitdir: ${outside}\n`);
  await symlink(outside, join(work, "link", ".git"));
  // A real clone with a commit: what `add -A` would record as a gitlink.
  await put("real/inside.c");
  await git(["-C", join(work, "real"), "init", "-q"]);
  await git(["-C", join(work, "real"), "-c", "user.name=s", "-c", "user.email=s@s", "commit", "-q", "--allow-empty", "-m", "one"]);
  return { volume, fifos };
}

const index = (volume: string) => gitBare(join(volume, "shadow.git"), ["ls-files", "--stage"]);
const files = async (volume: string) =>
  (await gitBare(join(volume, "shadow.git"), ["ls-tree", "-r", "--name-only", "HEAD"])).trim().split("\n");

describe("shadow snapshot and nested repositories (audit L23)", () => {
  it("the trap catches git's probe of a nested repository (the control)", async () => {
    const { volume, fifos } = await nestedWorkspace();
    const gitDir = join(volume, "shadow.git");
    await git(["init", "--bare", "-q", gitDir]);
    await mkdir(join(gitDir, "info"), { recursive: true });
    await writeFile(join(gitDir, "info", "exclude"), ".git\n");
    const { opened } = await watch(fifos, () =>
      git(["--git-dir", gitDir, "--work-tree", join(volume, "work"), "add", "-A", "--ignore-errors"]).catch(() => ""),
    );
    expect(opened).toBeGreaterThan(0);
  });

  it("never opens a nested .git of any kind, records no gitlink, and keeps the ordinary files", async () => {
    const { volume, fifos } = await nestedWorkspace();

    const { result, opened } = await watch(fifos, () => snapshot(volume));

    expect(opened).toBe(0);
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.unreadable).toEqual([]);
    expect(await index(volume)).not.toMatch(/^160000 /m);
    const tree = await files(volume);
    expect(tree).toEqual(expect.arrayContaining(["main.c", "a/b/kept.c", "clone2/beside.c"]));
    // Under a nested repository nothing is taken (a gitlink took nothing either),
    // and the student's own repository is not copied.
    expect(tree.filter((f) => f.includes("inside.c") || f.startsWith(".git"))).toEqual([]);

    // A second pass rewrites the exclusion and opens nothing either.
    const again = await watch(fifos, () => snapshot(volume));
    expect(again.opened).toBe(0);
    expect(again.result.sha).toBeNull();
  });

  it("captures a directory again once its .git is gone", async () => {
    const { volume, fifos } = await nestedWorkspace();
    await watch(fifos, () => snapshot(volume));
    await rm(join(volume, "work", "link", ".git"));
    const { opened } = await watch(fifos, () => snapshot(volume));
    expect(opened).toBe(0);
    expect(await files(volume)).toContain("link/inside.c");
  });

  it.skipIf(process.getuid?.() === 0)("tolerates and counts an unreadable file", async () => {
    const volume = join(root, "student", "tp");
    await mkdir(join(volume, "work"), { recursive: true });
    await writeFile(join(volume, "work", "open.c"), "a\n");
    await writeFile(join(volume, "work", "secret.c"), "b\n");
    await chmod(join(volume, "work", "secret.c"), 0o000);

    const result = await snapshot(volume);

    expect(result.sha).toBeTruthy();
    expect(result.unreadable).toEqual(["secret.c"]);
    expect(await files(volume)).toEqual(["open.c"]);
  });
});

describe("excludeLine", () => {
  it("anchors, escapes the special characters, and turns a control character into ?", () => {
    expect(excludeLine(Buffer.from("a/b")).toString()).toBe("/a/b/\n");
    expect(excludeLine(Buffer.from("we ird*[x]#!\\\nname")).toString()).toBe("/we\\ ird\\*\\[x\\]\\#\\!\\\\?name/\n");
    expect(excludeLine(Buffer.from([0xc3, 0xa9, 0x09])).equals(Buffer.from([0x2f, 0xc3, 0xa9, 0x3f, 0x2f, 0x0a]))).toBe(true);
  });
});
