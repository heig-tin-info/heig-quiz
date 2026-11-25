import { createRequire } from "node:module";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { FIXTURE_ENV, makeSourceRepo, tempDir } from "./git/fixtures.js";
import { git, gitBare } from "./git/gitRunner.js";
import { fetchProjectUpdate } from "./git/projectUpdate.js";
import { ensureStagingRepo, refSnapshot } from "./git/staging.js";

/**
 * The teacher's update in the workspace (ADR-132 §11), end to end on real
 * repositories: the student's GitHub repository holding the sync's commit on
 * `sync/main`, the portal's staging repository fetching it onto
 * `refs/quiz/update/main`, and the student's work tree — a clone of the
 * staging repository, as the portal's channel serves it — where the
 * status-bar extension's pure module (`images/quiz-base/extension/update.js`)
 * runs git as the student. The VS Code glue around it (`extension.js`) and
 * the image are checked by hand on the engine VM (`images/quiz-base/README.md`).
 */
type Run = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
type Update = { branch: string; sha: string; message: { text: string; at: string } | null };
const ext = createRequire(import.meta.url)("../images/quiz-base/extension/update.js") as {
  MERGE_MESSAGE: string;
  applyUpdate: (run: Run, update: Update) => Promise<{ outcome: string; files?: string[]; detail?: string }>;
  gitRunner: (cwd: string, env?: NodeJS.ProcessEnv) => Run;
  isTaken: (run: Run, sha: string) => Promise<boolean>;
  overwrittenFiles: (stderr: string) => string[];
  parseUpdate: (status: unknown) => Update | null;
  plainText: (text: string) => string;
};

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** The student's identity, as the portal sets it at `podman run` (`CONTAINER_ENV_KEYS`). */
const STUDENT = {
  GIT_AUTHOR_NAME: "Sacha Student",
  GIT_AUTHOR_EMAIL: "sacha@heig-vd.ch",
  GIT_COMMITTER_NAME: "Sacha Student",
  GIT_COMMITTER_EMAIL: "sacha@heig-vd.ch",
};

/**
 * The hand-out (README, a test, the student's file), the student's work
 * cloned from the staging repository with one commit of theirs pushed, the
 * teacher's sync (README and the test fixed) on the student's `sync/main`,
 * fetched by the portal.
 */
async function world() {
  const base = await tempDir("ws-update-");
  dirs.push(base);
  const github = await makeSourceRepo({
    dir: join(base, "github"),
    files: { "README.md": "Lab 1\n", "test.sh": "exit 1\n", "main.c": "int main(void) { return 0; }\n" },
  });
  const staging = await ensureStagingRepo({
    volumesRoot: join(base, "volumes"),
    student: "sacha",
    assignment: "lab",
    source: { mode: "lab", mirrorFrom: github.gitDir },
  });
  const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: base, GIT_CONFIG_NOSYSTEM: "1", ...STUDENT };
  const work = join(base, "work");
  await git(["clone", "-q", staging.gitDir, work], { env });
  const run = ext.gitRunner(work, env);
  await writeFile(join(work, "main.c"), "int main(void) { return 42; }\n");
  await git(["-C", work, "commit", "-qam", "my work"], { env });
  await git(["-C", work, "push", "-q", "origin", "main"], { env });

  const dist = join(base, "dist");
  await git(["clone", "-q", github.gitDir, dist], { env: FIXTURE_ENV });
  await writeFile(join(dist, "README.md"), "Lab 1, fixed\n");
  await writeFile(join(dist, "test.sh"), "exit 0\n");
  await git(["-C", dist, "commit", "-qam", "Project update"], { env: FIXTURE_ENV });
  await git(["-C", dist, "push", "-q", "origin", "HEAD:refs/heads/sync/main"], { env: FIXTURE_ENV });
  const sha = (await git(["-C", dist, "rev-parse", "HEAD"])).trim();
  await fetchProjectUpdate({ gitDir: staging.gitDir, url: github.gitDir, head: { branch: "main", sha } });
  const update: Update = { branch: "main", sha, message: { text: "Test fixed", at: "2026-11-17T20:00:00.000Z" } };
  return { base, work, env, run, update, stagingGitDir: staging.gitDir };
}

/** Every file of the work tree (its `.git` aside), the index's state, HEAD and any merge in progress. */
async function snapshot(work: string, run: Run): Promise<unknown> {
  const files: Record<string, string> = {};
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git" && prefix === "") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, `${prefix}${entry.name}/`);
      else files[`${prefix}${entry.name}`] = await readFile(path, "utf8");
    }
  };
  await walk(work, "");
  return {
    files,
    status: (await run(["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout,
    head: (await run(["rev-parse", "HEAD"])).stdout,
    merging: (await run(["rev-parse", "--quiet", "--verify", "MERGE_HEAD"])).code,
  };
}

describe("Apply, as the student", () => {
  it("merges the update beside uncommitted work on another file: a merge commit of the student's, the tree theirs plus the update, then a fast-forward push", async () => {
    const w = await world();
    const mine = (await w.run(["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(w.work, "main.c"), "int main(void) { return 7; }\n");
    await writeFile(join(w.work, "notes.txt"), "draft\n");
    expect(await ext.isTaken(w.run, w.update.sha)).toBe(false);

    expect(await ext.applyUpdate(w.run, w.update)).toEqual({ outcome: "applied" });
    const [parents, author, committer, subject] = (await w.run(["log", "-1", "--format=%P%n%an <%ae>%n%cn%n%s"])).stdout.trim().split("\n");
    expect(parents).toBe(`${mine} ${w.update.sha}`);
    expect(author).toBe("Sacha Student <sacha@heig-vd.ch>");
    expect(committer).toBe("Sacha Student");
    expect(subject).toBe(ext.MERGE_MESSAGE);
    expect((await w.run(["show", "HEAD:README.md"])).stdout).toBe("Lab 1, fixed\n");
    expect((await w.run(["show", "HEAD:test.sh"])).stdout).toBe("exit 0\n");
    expect((await w.run(["show", "HEAD:main.c"])).stdout).toBe("int main(void) { return 42; }\n");
    // The uncommitted work is where the student left it.
    expect(await readFile(join(w.work, "main.c"), "utf8")).toBe("int main(void) { return 7; }\n");
    expect(await readFile(join(w.work, "notes.txt"), "utf8")).toBe("draft\n");
    expect(await ext.isTaken(w.run, w.update.sha)).toBe(true);
    expect(await ext.applyUpdate(w.run, w.update)).toEqual({ outcome: "current" });

    // The next ordinary push: a fast-forward, holding the update.
    const pushed = await w.run(["push", "--porcelain", "origin", "main"]);
    expect(pushed.code).toBe(0);
    expect(pushed.stdout).not.toMatch(/forced update|\+/);
    const head = (await w.run(["rev-parse", "HEAD"])).stdout.trim();
    expect((await refSnapshot(w.stagingGitDir)).get("refs/heads/main")).toBe(head);
    await gitBare(w.stagingGitDir, ["merge-base", "--is-ancestor", w.update.sha, "refs/heads/main"]);
    await gitBare(w.stagingGitDir, ["merge-base", "--is-ancestor", mine, "refs/heads/main"]);
  });

  it("refuses beside an uncommitted change to a file the update touches, naming it: the work tree byte for byte as before", async () => {
    const w = await world();
    await writeFile(join(w.work, "README.md"), "Lab 1, my notes\n");
    await writeFile(join(w.work, "notes.txt"), "draft\n");
    const before = await snapshot(w.work, w.run);
    expect(await ext.applyUpdate(w.run, w.update)).toEqual({ outcome: "dirty", files: ["README.md"] });
    expect(await snapshot(w.work, w.run)).toEqual(before);

    // Staged, not committed: refused as well, nothing moved.
    await w.run(["add", "README.md"]);
    const staged = await snapshot(w.work, w.run);
    expect((await ext.applyUpdate(w.run, w.update)).outcome).toBe("dirty");
    expect(await snapshot(w.work, w.run)).toEqual(staged);
  });

  it("refuses on a committed conflicting change, naming the file, with no conflict state left: byte for byte as before", async () => {
    const w = await world();
    await writeFile(join(w.work, "test.sh"), "exit 2\n");
    await w.run(["commit", "-qam", "my own test"]);
    await writeFile(join(w.work, "main.c"), "int main(void) { return 7; }\n");
    const before = await snapshot(w.work, w.run);
    expect(await ext.applyUpdate(w.run, w.update)).toEqual({ outcome: "conflict", files: ["test.sh"] });
    expect(await snapshot(w.work, w.run)).toEqual(before);
    expect(await ext.isTaken(w.run, w.update.sha)).toBe(false);
  });

  it("leaves alone another branch, a merge of the student's own in progress, and an update the portal does not serve", async () => {
    const w = await world();
    await w.run(["switch", "-q", "-c", "experiment"]);
    expect(await ext.applyUpdate(w.run, w.update)).toEqual({ outcome: "otherBranch" });
    await w.run(["switch", "-q", "main"]);

    // The student's own merge, stopped on a conflict: theirs to finish, never aborted by the button.
    await w.run(["switch", "-q", "-c", "side"]);
    await writeFile(join(w.work, "main.c"), "side\n");
    await w.run(["commit", "-qam", "side"]);
    await w.run(["switch", "-q", "main"]);
    await writeFile(join(w.work, "main.c"), "main\n");
    await w.run(["commit", "-qam", "main"]);
    expect((await w.run(["merge", "side"])).code).not.toBe(0);
    const merging = await snapshot(w.work, w.run);
    expect(await ext.applyUpdate(w.run, w.update)).toEqual({ outcome: "busy" });
    expect(await snapshot(w.work, w.run)).toEqual(merging);
    await w.run(["merge", "--abort"]);

    await gitBare(w.stagingGitDir, ["update-ref", "-d", "refs/quiz/update/main"]);
    const other = { ...w.update, sha: "f".repeat(40) };
    expect(await ext.applyUpdate(w.run, other)).toEqual({ outcome: "unavailable" });
  });

  it("leaves alone a rebase of the student's own, stopped on a conflict: busy, not another branch", async () => {
    const w = await world();
    await w.run(["switch", "-q", "-c", "side"]);
    await writeFile(join(w.work, "main.c"), "side\n");
    await w.run(["commit", "-qam", "side"]);
    await w.run(["switch", "-q", "main"]);
    await writeFile(join(w.work, "main.c"), "main\n");
    await w.run(["commit", "-qam", "main"]);
    expect((await w.run(["rebase", "side"])).code).not.toBe(0);
    const rebasing = await snapshot(w.work, w.run);
    expect(await ext.applyUpdate(w.run, w.update)).toEqual({ outcome: "busy" });
    expect(await snapshot(w.work, w.run)).toEqual(rebasing);
  });

  it("never aborts a merge the student started in the terminal while the button was on its way: busy, their merge left as it was", async () => {
    const w = await world();
    await w.run(["switch", "-q", "-c", "side"]);
    await writeFile(join(w.work, "main.c"), "side\n");
    await w.run(["commit", "-qam", "side"]);
    await w.run(["switch", "-q", "main"]);
    await writeFile(join(w.work, "main.c"), "main\n");
    await w.run(["commit", "-qam", "main"]);
    let theirs: unknown = null;
    // The student's `git merge side` lands between the button's checks and its merge.
    const racing: Run = Object.assign(
      async (args: string[]) => {
        if (args[0] === "merge" && args.includes(ext.MERGE_MESSAGE)) {
          expect((await w.run(["merge", "side"])).code).not.toBe(0);
          theirs = await snapshot(w.work, w.run);
        }
        return w.run(args);
      },
      { cwd: w.work },
    );
    expect(await ext.applyUpdate(racing, w.update)).toEqual({ outcome: "busy" });
    expect(theirs).not.toBeNull();
    expect(await snapshot(w.work, w.run)).toEqual(theirs);
  });

  it("reports a merge a student's hook stopped as failed, the merge aborted, the work tree as before", async () => {
    const w = await world();
    const hook = join(w.work, ".git", "hooks", "pre-merge-commit");
    await writeFile(hook, "#!/bin/sh\necho 'no merge today' >&2\nexit 1\n", { mode: 0o755 });
    await writeFile(join(w.work, "notes.txt"), "draft\n");
    const before = await snapshot(w.work, w.run);
    const result = await ext.applyUpdate(w.run, w.update);
    expect(result.outcome).toBe("failed");
    expect(result.files).toBeUndefined();
    expect(await snapshot(w.work, w.run)).toEqual(before);
  });
});

describe("what the extension reads and shows", () => {
  it("takes push-status's update only with a full sha and a plain branch", () => {
    const sha = "a".repeat(40);
    expect(ext.parseUpdate({ update: null })).toBeNull();
    expect(ext.parseUpdate(null)).toBeNull();
    expect(ext.parseUpdate({ update: { branch: "main", sha: "HEAD", message: null } })).toBeNull();
    expect(ext.parseUpdate({ update: { branch: "--upload-pack=x", sha, message: null } })).toBeNull();
    expect(ext.parseUpdate({ update: { branch: "a..b", sha, message: null } })).toBeNull();
    expect(ext.parseUpdate({ update: { branch: "main", sha, message: { text: "Fixed.", at: "t" } } })).toEqual({
      branch: "main",
      sha,
      message: { text: "Fixed.", at: "t" },
    });
  });

  it("shows the teacher's text as text: no link, no icon, no control or direction character", () => {
    const shown = ext.plainText("See [the test](command:workbench.action.terminal.new) $(alert)\u202e\u0007 <b>now</b>\nline 2");
    expect(shown).not.toMatch(/\]\(|\$\(|[\u202e\u0007]/);
    expect(shown).toContain("<b>now</b>\nline 2");
  });

  it("names the files git would overwrite", () => {
    const stderr = [
      "error: Your local changes to the following files would be overwritten by merge:",
      "\tREADME.md",
      "\tsrc/a b.c",
      "Please commit your changes or stash them before you merge.",
      "error: The following untracked working tree files would be overwritten by merge:",
      "\tnew.txt",
      "Aborting",
    ].join("\n");
    expect(ext.overwrittenFiles(stderr)).toEqual(["README.md", "src/a b.c", "new.txt"]);
  });
});
