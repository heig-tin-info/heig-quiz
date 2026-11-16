/**
 * The property itself, on a real engine (rootful Podman and the student
 * image; `CODESPACE_INTEGRATION=1`, skipped when either is missing): what the
 * collection publishes holds nothing whose content comes from outside the
 * student's volume, and nothing outside it is ever opened — by the reader,
 * which cannot see it, nor by the host process, which reads no path of
 * `work/` (the portal's invariant 15, ADR-130 as corrected on 2026-11-16).
 *
 * Outside the volume: a secret file and directory, and traps — FIFOs, one
 * of them the `HEAD` of a repository a nested gitfile points at. Opening a
 * FIFO for reading blocks until a writer comes; {@link watch} looks every few
 * milliseconds for such a blocked reader (a non-blocking open for writing
 * succeeds only then), counts and releases it (the technique of PR #1128's
 * tests). Inside the volume, every way a student can point outside: absolute
 * and climbing symbolic links, a link to a directory, a nested gitfile, a
 * FIFO, a hard link, and two processes racing the reader — one swapping a
 * file for a link to the secret, one swapping a directory for a link to the
 * secret directory — in tight loops for the whole run.
 *
 * A hard link to a file OUTSIDE the volume is not among them: the student
 * cannot make one (the container sees no outside inode, and `link(2)` across
 * mounts fails), and the reader reads one exactly as any file of the volume.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, openSync } from "node:fs";
import { chmod, link, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectWorkspace, type CollectionOrder } from "../git/collect.js";
import { FIXTURE_ENV, tempDir } from "../git/fixtures.js";
import { git } from "../git/gitRunner.js";
import { stagingPaths } from "../git/staging.js";
import { ReaderTimeout, createWorkspaceReader } from "./reader.js";
import { localPodman } from "./readerFixtures.js";

const run = promisify(execFile);
const SOCKET = "/run/podman/podman.sock";
const IMAGE = "codespace/c-dev:4.137.0";
const INSTANCE = "itest";
const SECCOMP = fileURLToPath(new URL("../../infra/seccomp/codespace.json", import.meta.url));
const USER = "6f1c2a8e-1b2c-4d5e-8f90-123456789abc";
const PROJECT = "0b8e2f0a-6c1e-4c55-9a43-2f1e0c9d8a11";
const REF = "refs/quiz/collect/r1-1794836400";
const SECRET = `SECRET-${process.pid}-${Date.now()}`;

const podman = (...args: string[]) => run("podman", ["--remote", "--url", `unix://${SOCKET}`, ...args]);
const engineReady = existsSync(SOCKET) && (await podman("image", "exists", IMAGE).then(() => true, () => false));

const reader = createWorkspaceReader({ podmanUrl: `unix://${SOCKET}`, instance: INSTANCE, seccompProfile: SECCOMP, apparmorProfile: "", image: IMAGE });

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
  }, 5);
  try {
    return { result: await task(), opened };
  } finally {
    clearInterval(timer);
  }
}

const leftoverReaders = async () =>
  (await podman("ps", "--all", "--quiet", "--filter", "label=heig-codespace.role=reader", "--filter", `label=heig-codespace.instance=${INSTANCE}`)).stdout.trim();

describe.skipIf(!engineReady)("the confined reader on a real engine", () => {
  let root: string;
  let outside: string;
  let github: string;
  let work: string;
  let base: string;
  let volumesRoot: string;
  const fifos: string[] = [];
  const racers: ChildProcess[] = [];

  beforeAll(async () => {
    root = await tempDir("reader-itest-");
    await chmod(root, 0o755);
    outside = join(root, "outside");
    await mkdir(join(outside, "dir"), { recursive: true });
    await writeFile(join(outside, "secret.txt"), `${SECRET}\n`);
    await writeFile(join(outside, "dir", "inner.txt"), `${SECRET} inner\n`);
    await run("mkfifo", [join(outside, "trap.fifo")]);
    await git(["init", "--bare", "--quiet", join(outside, "repo.git")]);
    await rm(join(outside, "repo.git", "HEAD"));
    await run("mkfifo", [join(outside, "repo.git", "HEAD")]);
    fifos.push(join(outside, "trap.fifo"), join(outside, "repo.git", "HEAD"));

    const seed = join(root, "seed");
    await git(["init", "--quiet", "--initial-branch=main", seed]);
    await writeFile(join(seed, "main.c"), "int main(void) { return 1; }\n");
    await git(["-C", seed, "add", "-A"], { env: FIXTURE_ENV });
    await git(["-C", seed, "commit", "--quiet", "-m", "handout"], { env: FIXTURE_ENV });
    github = join(root, "github.git");
    await git(["clone", "--quiet", "--bare", seed, github]);
    base = (await git(["--git-dir", github, "rev-parse", "refs/heads/main"])).trim();

    volumesRoot = join(root, "volumes");
    const paths = stagingPaths(volumesRoot, USER, PROJECT);
    await mkdir(paths.dir, { recursive: true });
    await git(["clone", "--quiet", "--bare", github, paths.gitDir]);
    await git(["clone", "--quiet", github, paths.workDir]);
    work = paths.workDir;

    // Every way to point outside the volume a student has.
    await writeFile(join(work, "main.c"), "int main(void) { return 0; }\n");
    await symlink(join(outside, "secret.txt"), join(work, "abs"));
    await symlink("../../../../outside/secret.txt", join(work, "rel"));
    await symlink(join(outside, "trap.fifo"), join(work, "fifo-link"));
    await symlink(join(outside, "dir"), join(work, "dir-link"));
    await mkdir(join(work, "sub"));
    await writeFile(join(work, "sub", ".git"), `gitdir: ${join(outside, "repo.git")}\n`);
    await writeFile(join(work, "sub", "inside.c"), "inside\n");
    await git(["clone", "--quiet", github, join(work, "vendor")]);
    await run("mkfifo", [join(work, "pipe")]);
    fifos.push(join(work, "pipe"));
    await link(join(work, "main.c"), join(work, "hard.c"));
    await writeFile(join(work, "swap"), "mine\n");
    await mkdir(join(work, "d"));
    await writeFile(join(work, "d", "x.c"), "x\n");
    // The reader reads as "other", like any user that is not the session's.
    await run("chmod", ["-R", "a+rX", root]);
  });

  afterAll(async () => {
    for (const r of racers) r.kill("SIGKILL");
    if (root) await rm(root, { recursive: true, force: true });
  });

  /** The secret in any object GitHub's repository holds, every ref's and every loose one. */
  async function secretPublished(): Promise<boolean> {
    const { stdout } = await run("git", ["--git-dir", github, "cat-file", "--batch-all-objects", "--batch"], { maxBuffer: 1 << 26, encoding: "buffer" });
    return stdout.includes(SECRET);
  }

  it("publishes nothing from outside the volume and opens nothing outside it, while two processes race it", async () => {
    // A file swapped for a link to the secret, a directory swapped for a link to the secret directory.
    racers.push(
      spawn("sh", ["-c", `cd '${work}' && while :; do ln -sfn '${join(outside, "secret.txt")}' swap.new && mv -fT swap.new swap; printf 'mine\\n' > swap.f && mv -fT swap.f swap; done`]),
      spawn("sh", ["-c", `cd '${work}' && while :; do rm -rf d; ln -s '${join(outside, "dir")}' d; rm -f d; mkdir d && printf 'x\\n' > d/x.c; done`]),
    );
    const order: CollectionOrder = { assignment: PROJECT, userId: USER, repository: "heig-tin-info/lab3-alice", base, target: null, keep: [], ref: REF };
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      await git(["--git-dir", github, "update-ref", "-d", REF]).catch(() => "");
      const { result, opened } = await watch(fifos, () =>
        collectWorkspace(order, { volumesRoot, forge: { pushUrl: () => github, authorization: async () => "basic dGVzdA==" }, reader }),
      );
      outcomes.push(result.outcome);
      expect(opened).toBe(0);
      expect(await secretPublished()).toBe(false);
      expect(await leftoverReaders()).toBe("");
      if (result.outcome !== "pushed") continue;
      const listing = await git(["--git-dir", github, "ls-tree", "-r", REF]);
      // Links are carried as links: their target is a path, never the content behind it.
      expect(listing).toMatch(/^120000 blob \S+\tabs$/m);
      expect(listing).toMatch(/^120000 blob \S+\tdir-link$/m);
      expect((await git(["--git-dir", github, "cat-file", "blob", `${REF}:rel`])).trim()).toBe("../../../../outside/secret.txt");
      // The gitfile resolves to nothing in the reader: `sub` is an ordinary directory, its `.git` never
      // carried. A real nested repository is left out. The FIFO is no file, the hard link is the file it names.
      expect(listing).toMatch(/\tsub\/inside\.c$/m);
      expect(listing).not.toMatch(/\.git(\/|$)/m);
      expect(listing).not.toMatch(/\tvendor\//);
      expect(listing).not.toMatch(/\tpipe$/);
      expect((await git(["--git-dir", github, "cat-file", "blob", `${REF}:hard.c`])).trim()).toBe("int main(void) { return 0; }");
    }
    for (const r of racers.splice(0)) r.kill("SIGKILL");
    expect(outcomes.filter((o) => o === "pushed").length).toBeGreaterThan(0);
  }, 180_000);

  it("control: the same commands run unconfined on the host do open the trap", async () => {
    const host = createWorkspaceReader({ podmanUrl: "unused", instance: INSTANCE, seccompProfile: SECCOMP, image: IMAGE }, localPodman().spawn);
    const { opened } = await watch(fifos, () => host.read(work, 20_000, async (_, archive) => archive.resume()));
    expect(opened).toBeGreaterThan(0);
  }, 60_000);

  it("a directory swapped for a link INSIDE the reader publishes at most the reader's own image: something the student reads already", async () => {
    const imagePasswd = (await podman("run", "--rm", "--network", "none", "--entrypoint", "/usr/bin/cat", IMAGE, "/etc/passwd")).stdout;
    await mkdir(join(work, "e"));
    await writeFile(join(work, "e", "passwd"), "mine\n");
    await run("chmod", ["-R", "a+rX", join(work, "e")]);
    racers.push(spawn("sh", ["-c", `cd '${work}' && while :; do rm -rf e; ln -s /etc e; rm -f e; mkdir e && printf 'mine\\n' > e/passwd && chmod 755 e && chmod 644 e/passwd; done`]));
    const order: CollectionOrder = { assignment: PROJECT, userId: USER, repository: "heig-tin-info/lab3-alice", base, target: null, keep: [], ref: REF };
    const seen = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      await git(["--git-dir", github, "update-ref", "-d", REF]).catch(() => "");
      const result = await collectWorkspace(order, { volumesRoot, forge: { pushUrl: () => github, authorization: async () => "basic dGVzdA==" }, reader });
      expect(await secretPublished()).toBe(false);
      if (result.outcome !== "pushed") continue;
      const passwd = await git(["--git-dir", github, "cat-file", "blob", `${REF}:e/passwd`]).catch(() => null);
      if (passwd !== null) seen.add(passwd);
    }
    for (const r of racers.splice(0)) r.kill("SIGKILL");
    await rm(join(work, "e"), { recursive: true, force: true });
    // The student's own file, or the image's /etc/passwd the student's container shows anyway: never the host's.
    for (const content of seen) expect(["mine\n", imagePasswd]).toContain(content);
  }, 180_000);

  it("reads a 95 MiB tree within its 64 MiB memory limit", async () => {
    const big = join(work, "big");
    await mkdir(big);
    for (let i = 0; i < 19; i += 1) await writeFile(join(big, `blob${i}.bin`), randomBytes(5 * 1024 * 1024));
    await run("chmod", ["-R", "a+rX", big]);
    try {
      const order: CollectionOrder = { assignment: PROJECT, userId: USER, repository: "heig-tin-info/lab3-alice", base, target: null, keep: [], ref: REF };
      await git(["--git-dir", github, "update-ref", "-d", REF]).catch(() => "");
      const result = await collectWorkspace(order, { volumesRoot, forge: { pushUrl: () => github, authorization: async () => "basic dGVzdA==" }, reader });
      expect(result.outcome).toBe("pushed");
      expect(await git(["--git-dir", github, "ls-tree", "-r", "--name-only", REF, "big/"])).toContain("big/blob18.bin");
    } finally {
      await rm(big, { recursive: true, force: true });
    }
  }, 180_000);

  it("is removed when its time runs out, its consumer stuck", async () => {
    await expect(reader.read(work, 2_000, () => new Promise<never>(() => undefined))).rejects.toBeInstanceOf(ReaderTimeout);
    expect(await leftoverReaders()).toBe("");
  }, 60_000);

  it("sweeps what a crash left", async () => {
    const name = reader.readerName();
    const { readerArgs } = await import("./reader.js");
    await podman(...readerArgs({ podmanUrl: `unix://${SOCKET}`, instance: INSTANCE, seccompProfile: SECCOMP, apparmorProfile: "", image: IMAGE }, name, work, 60));
    expect(await leftoverReaders()).not.toBe("");
    expect(await reader.sweep()).toBe(1);
    expect(await leftoverReaders()).toBe("");
  }, 60_000);
});
