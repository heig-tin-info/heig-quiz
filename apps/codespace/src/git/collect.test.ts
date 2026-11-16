/**
 * The collection at the deadline (ADR-130), against real repositories in a
 * temporary directory: a bare repository stands for GitHub (a local path,
 * which `gitAuthEnv` gives no header), the volume holds `work/` (the
 * student's clone, its own `.git` included), `staging.git` and the
 * `shadow.git` the collection snapshots into.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { collectionKeptPaths } from "@quiz/domain";

import { snapshot } from "../sessions/shadow.js";
import { CollectionRefused, collectWorkspace, type CollectDeps, type CollectionOrder } from "./collect.js";
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
 * them.
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
    order: {
      assignment: PROJECT,
      userId: USER,
      repository: "heig-tin-info/lab3-alice",
      branch: "main",
      base,
      target: null,
      keep: collectionKeptPaths(["tests"]),
      ref: REF,
    },
  };
}

function deps(w: World, over: Partial<CollectDeps> = {}): CollectDeps {
  return {
    volumesRoot: w.volumesRoot,
    forge: { pushUrl: () => w.github, authorization: async () => "basic dGVzdA==" },
    lastPushAt: null,
    snapshotWaitMs: 1,
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
    expect((await git(["--git-dir", w.github, "rev-parse", REF])).trim()).toBe(result.commit);
    expect((await git(["--git-dir", w.github, "rev-parse", `${REF}^`])).trim()).toBe(w.base);
    expect((await git(["--git-dir", w.github, "rev-parse", `${REF}^{tree}`])).trim()).toBe(result.tree);
    const tree = await treeOf(w, REF);
    expect(Object.fromEntries(tree)).toEqual({
      ".github/workflows/ci.yml": ["100644", "on: push\n"],
      "link": ["120000", "/etc/passwd"],
      "main.c": ["100644", "int main(void) { return 0; }\n"],
      "notes.md": ["100644", "unpushed\n"],
      "tests/t.c": ["100644", "assert(1);\n"],
    });
    expect(result.unreadable).toBe(0);
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

  it("counts a change to a kept path only as no change", async () => {
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
    await expect(readdir(join(dirname(w.work), "shadow.git"))).rejects.toThrow();
  });

  it("falls back on the last snapshot when the index stays busy, unless it is older than the last push", async () => {
    const w = await world();
    await writeFiles(w.work, { "main.c": "saved before\n" });
    const volume = dirname(w.work);
    await snapshot(volume);
    const busy = vi.fn(async () => {
      throw new Error("Unable to create 'shadow.git/index.lock': File exists.");
    });

    const stale = await collectWorkspace(w.order, deps(w, { snapshot: busy, lastPushAt: new Date(Date.now() + 60_000) }));
    expect(stale.outcome).toBe("stale_snapshot");
    expect(busy).toHaveBeenCalledTimes(3);

    const last = await collectWorkspace(w.order, deps(w, { snapshot: busy, lastPushAt: new Date(0) }));
    expect(last.outcome).toBe("pushed");
    expect((await treeOf(w, REF)).get("main.c")).toEqual(["100644", "saved before\n"]);
  });

  it("refuses a hostile order before any git process, and touches nothing", async () => {
    const w = await world();
    const snap = vi.fn(snapshot);
    const authorization = vi.fn(async () => "basic dGVzdA==");
    const before = await refsOf(w.github);
    for (const bad of [
      { ref: "refs/heads/main" },
      { ref: "refs/quiz/collect/../../heads/main" },
      { branch: "--force" },
      { base: "HEAD" },
      { target: "--upload-pack=touch /tmp/x" },
      { keep: ["../../etc/passwd"] },
      { keep: ["/etc/passwd"] },
      { keep: ["-n"] },
      { userId: ".." },
      { assignment: "../other" },
      { repository: "owner/name/extra" },
    ] as Partial<CollectionOrder>[]) {
      await expect(collectWorkspace({ ...w.order, ...bad }, deps(w, { snapshot: snap, forge: { pushUrl: () => w.github, authorization } })), JSON.stringify(bad)).rejects.toBeInstanceOf(
        CollectionRefused,
      );
    }
    expect(snap).not.toHaveBeenCalled();
    expect(authorization).not.toHaveBeenCalled();
    expect(await refsOf(w.github)).toBe(before);
    await expect(readdir(join(dirname(w.work), "shadow.git"))).rejects.toThrow();
  });

  it("removes its temporary repository, alternates and index on every exit", async () => {
    const w = await world();
    const leftovers = async () => (await readdir(tmpdir())).filter((n) => n.startsWith("collect-") && !n.startsWith("collect-test-"));
    const before = await leftovers();
    await writeFiles(w.work, { "main.c": "changed\n" });
    await collectWorkspace(w.order, deps(w));
    await collectWorkspace(w.order, deps(w, { forge: { pushUrl: () => join(w.root, "missing.git"), authorization: async () => "x" } }));
    await collectWorkspace(w.order, deps(w, { forge: { pushUrl: () => w.github, authorization: async () => Promise.reject(new Error("down")) } }));
    expect(await leftovers()).toEqual(before);
  });
});
