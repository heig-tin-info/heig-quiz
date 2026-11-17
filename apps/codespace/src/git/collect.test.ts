/**
 * The collection at the deadline (ADR-130), against real repositories in a
 * temporary directory: a bare repository stands for GitHub (a local path,
 * which `gitAuthEnv` gives no header), the volume holds `work/` (the
 * student's clone, its own `.git` included) and `staging.git`. The reader is
 * the real one driven through `localPodman`, which runs its commands on the
 * host: these are the collection's behaviours; its confinement is proved on
 * a real engine (`engine/reader.integration.test.ts`). The orders are well
 * formed: the hostile ones are refused by the route's contract
 * (`collections.test.ts`).
 */
import { createHash } from "node:crypto";
import { chmod, link, mkdir, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createWorkspaceReader } from "../engine/reader.js";
import { localPodman, type LocalPodman, type LocalPodmanOptions } from "../engine/readerFixtures.js";
import { collectWorkspace, collectionDirsRoot, type CollectDeps, type CollectionOrder } from "./collect.js";
import { FIXTURE_ENV, tempDir } from "./fixtures.js";
import { git } from "./gitRunner.js";
import { stagingPaths } from "./staging.js";

const USER = "6f1c2a8e-1b2c-4d5e-8f90-123456789abc";
const PROJECT = "0b8e2f0a-6c1e-4c55-9a43-2f1e0c9d8a11";
const REF = "refs/quiz/collect/r1-1794836400";

const roots: string[] = [];
afterAll(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content, "utf8");
  }
}

/** Every file under `dir` and its SHA-256: a byte-for-byte picture. */
async function picture(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out.set(path, createHash("sha256").update(await readFile(path)).digest("hex"));
  }
  return out;
}

interface World {
  root: string;
  github: string;
  base: string;
  volumesRoot: string;
  work: string;
  staging: string;
  order: CollectionOrder;
}

/**
 * GitHub's repository with the handed-out branch `main`, the student's
 * clone in `work/` and the mirror in `staging.git`, as a session leaves
 * them. Quiz's kept paths name `tests` only: the portal keeps the workflows
 * on its own.
 */
async function world(): Promise<World> {
  const root = await tempDir("collect-test-");
  roots.push(root);
  const seed = join(root, "seed");
  await git(["init", "--quiet", "--initial-branch=main", seed]);
  await writeFiles(seed, {
    "main.c": "int main(void) { return 1; }\n",
    "tests/t.c": "assert(1);\n",
    ".github/workflows/ci.yml": "on: push\n",
  });
  await git(["-C", seed, "add", "-A"], { env: FIXTURE_ENV });
  await git(["-C", seed, "commit", "--quiet", "-m", "handout"], { env: FIXTURE_ENV });
  const github = join(root, "github.git");
  await git(["clone", "--quiet", "--bare", seed, github]);
  const base = (await git(["--git-dir", github, "rev-parse", "refs/heads/main"])).trim();

  const volumesRoot = join(root, "volumes");
  const paths = stagingPaths(volumesRoot, USER, PROJECT);
  await mkdir(paths.dir, { recursive: true });
  await git(["clone", "--quiet", "--bare", github, paths.gitDir]);
  await git(["clone", "--quiet", github, paths.workDir]);
  return {
    root,
    github,
    base,
    volumesRoot,
    work: paths.workDir,
    staging: paths.gitDir,
    order: { assignment: PROJECT, userId: USER, repository: "heig-tin-info/lab3-alice", base, target: null, keep: ["tests"], ref: REF },
  };
}

const READER = { podmanUrl: "unix:///run/podman/podman.sock", instance: "test", seccompProfile: "/seccomp.json", image: "codespace/c-dev:4.137.0" };

let podman: LocalPodman = localPodman();

function deps(w: World, over: Partial<CollectDeps> = {}, engine: LocalPodmanOptions = {}): CollectDeps {
  podman = localPodman(engine);
  return {
    volumesRoot: w.volumesRoot,
    forge: { pushUrl: () => w.github, authorization: async () => "basic dGVzdA==" },
    reader: createWorkspaceReader(READER, podman.spawn),
    ...over,
  };
}

/** `ls-tree -r` of `treeish` in GitHub's repository: path → [mode, content]. */
async function treeOf(w: World, treeish: string): Promise<Map<string, [string, string]>> {
  const out = new Map<string, [string, string]>();
  const listing = await git(["--git-dir", w.github, "ls-tree", "-r", "-z", treeish]);
  for (const line of listing.split("\0").filter(Boolean)) {
    const [meta, path] = line.split("\t") as [string, string];
    const [mode, , sha] = meta.split(" ") as [string, string, string];
    out.set(path, [mode, await git(["--git-dir", w.github, "cat-file", "blob", sha])]);
  }
  return out;
}

const refsOf = (gitDir: string) => git(["--git-dir", gitDir, "for-each-ref", "--format=%(refname) %(objectname)"]);

describe("collectWorkspace", () => {
  it("pushes the workspace on the temporary ref, the kept paths from the base, a symbolic link as a link", async () => {
    const w = await world();
    await writeFiles(w.work, { "main.c": "int main(void) { return 0; }\n", "tests/t.c": "assert(0); /* tampered */\n", "notes.md": "unpushed\n" });
    await unlink(join(w.work, ".github/workflows/ci.yml"));
    await symlink("/etc/passwd", join(w.work, "link"));
    const studentGit = await picture(join(w.work, ".git"));
    const staging = await picture(w.staging);
    const githubBranches = await git(["--git-dir", w.github, "for-each-ref", "refs/heads"]);

    const result = await collectWorkspace(w.order, deps(w));

    expect(result.outcome).toBe("pushed");
    if (result.outcome !== "pushed") return;
    expect((await git(["--git-dir", w.github, "rev-parse", `${REF}^`])).trim()).toBe(w.base);
    expect((await git(["--git-dir", w.github, "rev-parse", `${REF}^{tree}`])).trim()).toBe(result.tree);
    expect(Object.fromEntries(await treeOf(w, REF))).toEqual({
      ".github/workflows/ci.yml": ["100644", "on: push\n"],
      "link": ["120000", "/etc/passwd"],
      "main.c": ["100644", "int main(void) { return 0; }\n"],
      "notes.md": ["100644", "unpushed\n"],
      "tests/t.c": ["100644", "assert(1);\n"],
    });
    expect(result.unreadable).toBe(0);
    // The reader was removed, and no shadow.git was made or read.
    expect(podman.live()).toEqual([]);
    await expect(readdir(join(dirname(w.work), "shadow.git"))).rejects.toThrow();
    // Nothing of the student's repository, the staging repository or GitHub's branches moved.
    expect(await picture(join(w.work, ".git"))).toEqual(studentGit);
    expect(await picture(w.staging)).toEqual(staging);
    expect(await git(["--git-dir", w.github, "for-each-ref", "refs/heads"])).toBe(githubBranches);
  });

  it("compares with the target, and pushes nothing when the workspace is what would be graded", async () => {
    const w = await world();
    const before = await refsOf(w.github);
    const settle = vi.fn();
    const result = await collectWorkspace(w.order, deps(w, { forge: { pushUrl: () => w.github, authorization: async () => "basic dGVzdA==", settle } }));
    expect(result.outcome).toBe("unchanged");
    expect(await refsOf(w.github)).toBe(before);
    expect(settle).toHaveBeenCalledOnce();
  });

  it("counts a change to a kept path only as no change, the workflows kept though Quiz's list omits them", async () => {
    const w = await world();
    await writeFiles(w.work, { "tests/t.c": "assert(0);\n", ".github/workflows/evil.yml": "on: push\n" });
    expect((await collectWorkspace(w.order, deps(w))).outcome).toBe("unchanged");
  });

  it("collects against a target older than the base, fetched from GitHub when the host lacks it", async () => {
    const w = await world();
    // A late push of the student moved GitHub's head past the target; the host never saw it.
    const late = join(w.root, "late");
    await git(["clone", "--quiet", w.github, late]);
    await writeFiles(late, { "main.c": "int main(void) { return 0; }\n" });
    await git(["-C", late, "commit", "--quiet", "-am", "late"], { env: FIXTURE_ENV });
    await git(["-C", late, "push", "--quiet", "origin", "main"]);
    const head = (await git(["--git-dir", w.github, "rev-parse", "refs/heads/main"])).trim();
    await writeFiles(w.work, { "main.c": "int main(void) { return 0; }\n" });

    const result = await collectWorkspace({ ...w.order, base: head, target: w.base }, deps(w));
    expect(result.outcome).toBe("pushed");
    expect((await git(["--git-dir", w.github, "rev-parse", `${REF}^`])).trim()).toBe(head);
  });

  it("never forces: a temporary ref already elsewhere is a failure, left as it was", async () => {
    const w = await world();
    const other = join(w.root, "other");
    await git(["init", "--quiet", "--initial-branch=x", other]);
    await writeFiles(other, { "x": "x\n" });
    await git(["-C", other, "add", "-A"], { env: FIXTURE_ENV });
    await git(["-C", other, "commit", "--quiet", "-m", "x"], { env: FIXTURE_ENV });
    await git(["-C", other, "push", "--quiet", w.github, `HEAD:${REF}`]);
    const held = (await git(["--git-dir", w.github, "rev-parse", REF])).trim();
    await writeFiles(w.work, { "main.c": "changed\n" });

    expect(await collectWorkspace(w.order, deps(w))).toEqual({ outcome: "failed", reason: "push_rejected" });
    expect((await git(["--git-dir", w.github, "rev-parse", REF])).trim()).toBe(held);
  });

  it("says no_snapshot for a workspace never opened, and creates nothing", async () => {
    const w = await world();
    await rm(w.work, { recursive: true, force: true });
    expect(await collectWorkspace(w.order, deps(w))).toEqual({ outcome: "no_snapshot" });
    // No reader was started for it.
    expect(podman.calls).toEqual([]);
  });

  it("never reads shadow.git: the timer's snapshot is not what is handed in", async () => {
    const w = await world();
    // A shadow.git the timer could have written, holding other content.
    const other = join(w.root, "other");
    await git(["init", "--quiet", "--initial-branch=main", other]);
    await writeFiles(other, { "main.c": "in the snapshot only\n" });
    await git(["-C", other, "add", "-A"], { env: FIXTURE_ENV });
    await git(["-C", other, "commit", "--quiet", "-m", "snapshot"], { env: FIXTURE_ENV });
    await git(["clone", "--quiet", "--bare", other, join(dirname(w.work), "shadow.git")]);
    expect((await collectWorkspace(w.order, deps(w))).outcome).toBe("unchanged");
  });

  it("honours the student's .gitignore, its negations and nested ones, and leaves out a nested repository", async () => {
    const w = await world();
    await writeFiles(w.work, {
      ".gitignore": "build/\n*.o\n!keep.o\n",
      "build/out.txt": "built\n",
      "a.o": "object\n",
      "keep.o": "kept\n",
      "lib/.gitignore": "secret.txt\n",
      "lib/secret.txt": "ignored here\n",
      "lib/code.c": "code\n",
    });
    await git(["clone", "--quiet", w.github, join(w.work, "vendor")]);

    const result = await collectWorkspace(w.order, deps(w));
    expect(result.outcome).toBe("pushed");
    expect([...(await treeOf(w, REF)).keys()].sort()).toEqual([
      ".github/workflows/ci.yml",
      ".gitignore",
      "keep.o",
      "lib/.gitignore",
      "lib/code.c",
      "main.c",
      "tests/t.c",
    ]);
  });

  it("keeps a file or a directory the reader cannot read as the commit that would be graded has it, and counts it", async () => {
    const w = await world();
    await writeFiles(w.work, { "main.c": "edited but unreadable\n", "private/new.c": "never seen\n", "notes.md": "readable\n" });
    await chmod(join(w.work, "main.c"), 0o000);
    await chmod(join(w.work, "private"), 0o000);
    try {
      const result = await collectWorkspace(w.order, deps(w));
      expect(result).toMatchObject({ outcome: "pushed", unreadable: 2 });
      expect(Object.fromEntries(await treeOf(w, REF))).toEqual({
        ".github/workflows/ci.yml": ["100644", "on: push\n"],
        "main.c": ["100644", "int main(void) { return 1; }\n"],
        "notes.md": ["100644", "readable\n"],
        "tests/t.c": ["100644", "assert(1);\n"],
      });
    } finally {
      await chmod(join(w.work, "main.c"), 0o644);
      await chmod(join(w.work, "private"), 0o755);
    }
  });

  it("is too_large past the cap on entries: a listing over it, or an unreadable directory the graded commit fills over it", async () => {
    const w = await world();
    await writeFiles(w.work, Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`many/f${i}.c`, "x\n"])));
    expect(await collectWorkspace(w.order, deps(w, { maxEntries: 5 }))).toMatchObject({ outcome: "too_large" });
    expect(podman.live()).toEqual([]);

    // The handout holds six files under data/; the student made data/ unreadable: the listing is small,
    // the workspace once data/ is taken from the graded commit is not.
    const big = await world();
    const seed = join(big.root, "seed2");
    await git(["clone", "--quiet", big.github, seed]);
    await writeFiles(seed, Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`data/d${i}.txt`, `${i}\n`])));
    await git(["-C", seed, "add", "-A"], { env: FIXTURE_ENV });
    await git(["-C", seed, "commit", "--quiet", "-m", "data"], { env: FIXTURE_ENV });
    await git(["-C", seed, "push", "--quiet", "origin", "main"]);
    const head = (await git(["--git-dir", big.github, "rev-parse", "refs/heads/main"])).trim();
    await writeFiles(big.work, { "data/d0.txt": "mine\n" });
    await chmod(join(big.work, "data"), 0o000);
    try {
      expect(await collectWorkspace({ ...big.order, base: head }, deps(big, { maxEntries: 8 }))).toMatchObject({ outcome: "too_large", unreadable: 1 });
    } finally {
      await chmod(join(big.work, "data"), 0o755);
    }
  });

  it("carries the execute bit, and a hard link as the file it names", async () => {
    const w = await world();
    await writeFiles(w.work, { "run.sh": "#!/bin/sh\n" });
    await chmod(join(w.work, "run.sh"), 0o755);
    await link(join(w.work, "run.sh"), join(w.work, "again.sh"));
    expect((await collectWorkspace(w.order, deps(w))).outcome).toBe("pushed");
    const tree = await treeOf(w, REF);
    expect(tree.get("run.sh")).toEqual(["100755", "#!/bin/sh\n"]);
    expect(tree.get("again.sh")).toEqual(["100755", "#!/bin/sh\n"]);
  });

  it("is too_large past the cap on the workspace's files, and pushes nothing", async () => {
    const w = await world();
    const before = await refsOf(w.github);
    await writeFiles(w.work, { "big.bin": "x".repeat(4096) });
    expect(await collectWorkspace(w.order, deps(w, { maxBytes: 1024 }))).toMatchObject({ outcome: "too_large", unreadable: 0 });
    expect(await refsOf(w.github)).toBe(before);
    expect(podman.live()).toEqual([]);
  });

  it("fails read_failed when the reader cannot start or its archive is refused, and removes it", async () => {
    const w = await world();
    await writeFiles(w.work, { "main.c": "changed\n" });
    expect(await collectWorkspace(w.order, deps(w, {}, { failRun: true }))).toEqual({ outcome: "failed", reason: "read_failed" });
    expect(podman.calls.some((c) => c[0] === "rm")).toBe(true);
    const junk = join(w.root, "junk.tar");
    await writeFile(junk, Buffer.alloc(2048, 0x41));
    expect(await collectWorkspace(w.order, deps(w, {}, { archiveFile: junk }))).toEqual({ outcome: "failed", reason: "read_failed" });
    expect(podman.live()).toEqual([]);
  });

  it("stops at its time budget and pushes nothing", async () => {
    const w = await world();
    await writeFiles(w.work, { "main.c": "changed\n" });
    const before = await refsOf(w.github);
    expect(await collectWorkspace(w.order, deps(w, { budgetMs: 1500 }, { hangArchive: true }))).toEqual({ outcome: "failed", reason: "timeout" });
    // The stuck reader is removed all the same.
    expect(podman.live()).toEqual([]);
    const late = vi.fn(async () => new Promise<string>((r) => setTimeout(() => r("basic bGF0ZQ=="), 400)));
    const settle = vi.fn();
    expect(await collectWorkspace(w.order, deps(w, { budgetMs: 300, forge: { pushUrl: () => w.github, authorization: late, settle } }))).toEqual({ outcome: "failed", reason: "timeout" });
    expect(await refsOf(w.github)).toBe(before);
    // The token that landed after the budget is released, not left to its expiry.
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith("basic bGF0ZQ=="));
  });

  it("removes its temporary repository, alternates and index on every exit", async () => {
    const w = await world();
    const leftovers = async () => readdir(collectionDirsRoot(w.volumesRoot)).catch(() => []);
    await writeFiles(w.work, { "main.c": "changed\n" });
    await collectWorkspace(w.order, deps(w));
    await collectWorkspace(w.order, deps(w, { forge: { pushUrl: () => join(w.root, "missing.git"), authorization: async () => "x" } }));
    await collectWorkspace(w.order, deps(w, { forge: { pushUrl: () => w.github, authorization: async () => Promise.reject(new Error("down")) } }));
    expect(await leftovers()).toEqual([]);
    expect(podman.live()).toEqual([]);
  });
});
