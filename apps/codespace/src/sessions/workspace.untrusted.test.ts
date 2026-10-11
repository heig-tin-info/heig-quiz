/**
 * Audit L23: a `.git` in `work/` may be the student's, crafted to run code
 * as the portal (hooks, `core.fsmonitor`, `include.path`, `alternates`). The
 * portal reads what it needs of it as plain files and never runs git on it;
 * what must be done in it is done in the container.
 *
 * `git` is the real one, wrapped to record every call `workspace.ts` makes.
 */
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { git } from "../git/index.js";
import { FIXTURE_ENV, makeSourceRepo } from "../git/fixtures.js";

import { ensureWorkspace, inspectWorkspace } from "./workspace.js";

vi.mock("../git/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../git/index.js")>();
  return { ...real, git: vi.fn(real.git) };
});

let root: string;
let work: string;
let marker: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "l23-"));
  work = join(root, "work");
  marker = join(root, "PWNED");
  await mkdir(work);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exists = (path: string) => stat(path).then(() => true, () => false);

/** A shell script that, run by anything, leaves the marker. */
async function payload(): Promise<string> {
  const script = join(root, "payload.sh");
  await writeFile(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, "utf8");
  await chmod(script, 0o755);
  return script;
}

/**
 * The student's crafted repository: a hook on every checkout and commit, a
 * filesystem monitor, an included config that names them again, and an
 * `alternates` pointing out of the volume. Unborn, unless `commit`.
 */
async function craftedRepo(opts: { commit?: boolean } = {}): Promise<void> {
  await git(["init", "-q", "--initial-branch=main", work], { env: FIXTURE_ENV });
  if (opts.commit) {
    await writeFile(join(work, "main.c"), "int main(void){return 0;}\n", "utf8");
    await git(["-C", work, "add", "-A"], { env: FIXTURE_ENV });
    await git(["-C", work, "commit", "-q", "-m", "work"], { env: FIXTURE_ENV });
  }
  const script = await payload();
  for (const hook of ["post-checkout", "pre-commit", "reference-transaction", "post-index-change"]) {
    await writeFile(join(work, ".git", "hooks", hook), `#!/bin/sh\nexec ${script}\n`, "utf8");
    await chmod(join(work, ".git", "hooks", hook), 0o755);
  }
  await writeFile(join(root, "included"), `[core]\n\tfsmonitor = ${script}\n`, "utf8");
  const config = join(work, ".git", "config");
  await writeFile(
    config,
    `[core]\n\tfsmonitor = ${script}\n\tpager = ${script}\n[include]\n\tpath = ${join(root, "included")}\n`,
    { flag: "a" },
  );
  await writeFile(join(work, ".git", "objects", "info", "alternates"), "/etc\n", "utf8");
}

/** The calls `workspace.ts` made to git that name the student's `work/`. */
function gitCallsOnWork(): string[][] {
  return vi.mocked(git).mock.calls.map(([args]) => args).filter((args) => args.some((a) => a.includes(work)));
}

describe("inspectWorkspace reads the student's .git as plain files", () => {
  it("never runs git, never runs the student's hooks or config, and still reads HEAD", async () => {
    await craftedRepo({ commit: true });
    vi.mocked(git).mockClear();
    expect(await inspectWorkspace(work)).toEqual({ present: true, born: true, branch: "main" });
    expect(vi.mocked(git)).not.toHaveBeenCalled();
    expect(await exists(marker)).toBe(false);
  });

  it("an unborn branch, a packed ref, a detached HEAD, and no .git at all", async () => {
    expect(await inspectWorkspace(work)).toEqual({ present: false, born: false, branch: null });
    await git(["init", "-q", "--initial-branch=trunk", work]);
    expect(await inspectWorkspace(work)).toEqual({ present: true, born: false, branch: "trunk" });
    const sha = "a".repeat(40);
    await writeFile(join(work, ".git", "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${sha} refs/heads/trunk\n`);
    expect(await inspectWorkspace(work)).toEqual({ present: true, born: true, branch: "trunk" });
    await writeFile(join(work, ".git", "HEAD"), `${sha}\n`);
    expect(await inspectWorkspace(work)).toEqual({ present: true, born: true, branch: null });
  });

  it("a branch in a directory reads its loose ref there, and nowhere above", async () => {
    await git(["init", "-q", "--initial-branch=feature/x", work]);
    expect(await inspectWorkspace(work)).toEqual({ present: true, born: false, branch: "feature/x" });
    await mkdir(join(work, ".git", "refs", "heads", "feature"), { recursive: true });
    await writeFile(join(work, ".git", "refs", "heads", "feature", "x"), `${"b".repeat(64)}\n`);
    expect(await inspectWorkspace(work)).toEqual({ present: true, born: true, branch: "feature/x" });
    // A branch that would climb out of `refs/heads/`: not judged, left alone.
    await writeFile(join(work, ".git", "HEAD"), "ref: refs/heads/../../config\n");
    expect(await inspectWorkspace(work)).toEqual({ present: true, born: true, branch: null });
  });

  it("whatever is not a plain repository is the student's, left alone and never followed", async () => {
    // `.git` a symlink to another repository of the host.
    const elsewhere = join(root, "elsewhere");
    await git(["init", "-q", elsewhere]);
    await symlink(join(elsewhere, ".git"), join(work, ".git"));
    expect(await inspectWorkspace(work)).toEqual({ present: true, born: true, branch: null });
    await rm(join(work, ".git"));
    // `.git` a `gitdir:` file.
    await writeFile(join(work, ".git"), `gitdir: ${join(elsewhere, ".git")}\n`);
    expect(await inspectWorkspace(work)).toEqual({ present: true, born: true, branch: null });
    await rm(join(work, ".git"));
    // `HEAD` a symlink to a file of the host that reads as a ref.
    await git(["init", "-q", "--initial-branch=main", work]);
    await writeFile(join(root, "fake-head"), "ref: refs/heads/main\n");
    await rm(join(work, ".git", "HEAD"));
    await symlink(join(root, "fake-head"), join(work, ".git", "HEAD"));
    expect(await inspectWorkspace(work)).toEqual({ present: true, born: true, branch: null });
    // `HEAD` a FIFO: the read does not block on it.
    await rm(join(work, ".git", "HEAD"));
    execFileSync("mkfifo", [join(work, ".git", "HEAD")]);
    expect(await inspectWorkspace(work)).toEqual({ present: true, born: true, branch: null });
    // A reftable repository: HEAD names `.invalid`.
    await rm(join(work, ".git", "HEAD"));
    await writeFile(join(work, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
    expect(await inspectWorkspace(work)).toEqual({ present: true, born: true, branch: null });
  });
});

describe("ensureWorkspace on an existing .git", () => {
  async function staging(): Promise<{ dir: string; gitDir: string; workDir: string }> {
    const source = await makeSourceRepo({ dir: join(root, "src"), files: { "lab.c": "int x;\n" } });
    return { dir: root, gitDir: source.gitDir, workDir: work };
  }
  const options = async () => ({
    paths: await staging(),
    sessionId: "s1",
    gitRemoteHost: "portal.internal",
    gitRemotePort: 9418,
    identity: { name: "Sacha Student", email: "sacha@heig-vd.ch" },
  });

  it("an unborn crafted repository, even one the portal could write, is completed in the container", async () => {
    await craftedRepo();
    const opts = await options();
    vi.mocked(git).mockClear();
    // Before audit L23 the host fetched and checked out here, and the
    // student's post-checkout hook and fsmonitor ran as the portal.
    expect(await ensureWorkspace(opts)).toEqual({ created: false, branch: "main", needsContainer: true, needsIdentity: true });
    expect(gitCallsOnWork()).toEqual([]);
    expect(await exists(marker)).toBe(false);
  });

  it("a born crafted repository is left alone, its identity set in the container", async () => {
    await craftedRepo({ commit: true });
    const opts = await options();
    vi.mocked(git).mockClear();
    expect(await ensureWorkspace(opts)).toEqual({ created: false, branch: "main", needsContainer: false, needsIdentity: true });
    expect(gitCallsOnWork()).toEqual([]);
    expect(await exists(marker)).toBe(false);
  });

  it("a repository the portal creates is seeded from the host, hooks and fsmonitor disabled", async () => {
    const opts = await options();
    vi.mocked(git).mockClear();
    expect(await ensureWorkspace(opts)).toEqual({ created: true, branch: "main", needsContainer: false, needsIdentity: false });
    const calls = gitCallsOnWork();
    expect(calls[0]?.slice(0, 2)).toEqual(["init", "-q"]);
    for (const args of calls.filter((a) => a[0] === "-c")) {
      expect(args).toEqual(expect.arrayContaining(["core.hooksPath=/dev/null", "core.fsmonitor=false"]));
    }
    expect((await git(["-C", work, "config", "--local", "user.name"])).trim()).toBe("Sacha Student");
  });
});
