/**
 * Audit L23: a `.git` in `work/` may be the student's, crafted to run code
 * or read files as the portal (hooks, `core.fsmonitor`, `include.path`,
 * `alternates`, symlinks). The host reads nothing of it and runs no git on
 * it: it only asks whether one exists, and leaves the rest to the container.
 *
 * `git` is the real one, wrapped to record every call `workspace.ts` makes.
 */
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
  await mkdir(work, { mode: 0o755 });
  await chmod(work, 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exists = (path: string) => stat(path).then(() => true, () => false);

/**
 * The student's crafted repository: a hook on every checkout, commit and
 * index change, a filesystem monitor and a pager that leave the marker, an
 * included config, and `alternates` pointing out of the volume.
 */
async function craftedRepo(opts: { commit?: boolean } = {}): Promise<void> {
  await git(["init", "-q", "--initial-branch=main", work], { env: FIXTURE_ENV });
  if (opts.commit) {
    await writeFile(join(work, "main.c"), "int main(void){return 0;}\n", "utf8");
    await git(["-C", work, "add", "main.c"], { env: FIXTURE_ENV });
    await git(["-C", work, "commit", "-q", "-m", "work"], { env: FIXTURE_ENV });
  }
  const script = join(root, "payload.sh");
  await writeFile(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, "utf8");
  await chmod(script, 0o755);
  for (const hook of ["post-checkout", "pre-commit", "reference-transaction", "post-index-change"]) {
    await writeFile(join(work, ".git", "hooks", hook), `#!/bin/sh\nexec ${script}\n`, "utf8");
    await chmod(join(work, ".git", "hooks", hook), 0o755);
  }
  await writeFile(join(root, "included"), `[core]\n\tfsmonitor = ${script}\n`, "utf8");
  await writeFile(
    join(work, ".git", "config"),
    `[core]\n\tfsmonitor = ${script}\n\tpager = ${script}\n[include]\n\tpath = ${join(root, "included")}\n`,
    { flag: "a" },
  );
  await writeFile(join(work, ".git", "objects", "info", "alternates"), "/etc\n", "utf8");
}

/** The calls `workspace.ts` made to git that name the student's `work/`. */
function gitCallsOnWork(): string[][] {
  return vi.mocked(git).mock.calls.map(([args]) => args).filter((args) => args.some((a) => a.includes(work)));
}

describe("inspectWorkspace looks at work/.git's presence, nothing else", () => {
  it("absent, a directory, a gitdir: file, a symlink: present or not, never read nor followed", async () => {
    expect(await inspectWorkspace(work)).toEqual({ present: false, owned: true });
    await symlink(join(root, "nowhere"), join(work, ".git"));
    expect(await inspectWorkspace(work)).toEqual({ present: true, owned: true });
    await rm(join(work, ".git"));
    await writeFile(join(work, ".git"), `gitdir: ${root}\n`);
    expect(await inspectWorkspace(work)).toEqual({ present: true, owned: true });
    await rm(join(work, ".git"));
    await craftedRepo({ commit: true });
    vi.mocked(git).mockClear();
    expect(await inspectWorkspace(work)).toEqual({ present: true, owned: true });
    expect(vi.mocked(git)).not.toHaveBeenCalled();
    expect(await exists(marker)).toBe(false);
  });

  it("work/ is the portal's alone only when no group nor other may write it, and it is no symlink", async () => {
    await chmod(work, 0o775);
    expect((await inspectWorkspace(work)).owned).toBe(false);
    await chmod(work, 0o757);
    expect((await inspectWorkspace(work)).owned).toBe(false);
    await chmod(work, 0o755);
    const link = join(root, "link");
    await symlink(work, link);
    expect((await inspectWorkspace(link)).owned).toBe(false);
  });
});

describe("ensureWorkspace never runs git on a .git it did not create", () => {
  const options = async () => {
    const source = await makeSourceRepo({ dir: join(root, "src"), files: { "lab.c": "int x;\n" } });
    return {
      paths: { dir: root, gitDir: source.gitDir, workDir: work },
      sessionId: "s1",
      gitRemoteHost: "portal.internal",
      gitRemotePort: 9418,
      identity: { name: "Sacha Student", email: "sacha@heig-vd.ch" },
    };
  };

  for (const commit of [false, true]) {
    it(`a crafted ${commit ? "born" : "unborn"} repository, in a work/ the portal could write, goes to the container`, async () => {
      await craftedRepo({ commit });
      const opts = await options();
      vi.mocked(git).mockClear();
      // Before audit L23 the host fetched and checked out an unborn one here,
      // and the student's post-checkout hook and fsmonitor ran as the portal.
      expect(await ensureWorkspace(opts)).toEqual({ created: false, branch: "main", needsContainer: true, needsIdentity: true });
      expect(gitCallsOnWork()).toEqual([]);
      expect(await exists(marker)).toBe(false);
    });
  }

  it("no .git, but a work/ others may write: the container seeds it, not the host", async () => {
    await chmod(work, 0o777);
    const opts = await options();
    vi.mocked(git).mockClear();
    expect(await ensureWorkspace(opts)).toEqual({ created: false, branch: "main", needsContainer: true, needsIdentity: true });
    expect(gitCallsOnWork()).toEqual([]);
    expect(await exists(join(work, ".git"))).toBe(false);
  });

  it("no .git in the portal's own work/: seeded from the host, hooks and fsmonitor off", async () => {
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
