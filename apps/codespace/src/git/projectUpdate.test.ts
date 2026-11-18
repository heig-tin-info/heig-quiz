/**
 * The teacher's update in a staging repository (ADR-132 §11), on real git:
 * the commit fetched by sha onto `refs/quiz/update/<branch>`, no branch
 * moved, idempotent, moved by a later sync; the authorization asked only
 * when a ref is missing; a failure leaving everything as it was; a
 * student's push to `refs/quiz/*` refused; the portal's refs never a
 * `PushEvent`.
 */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { FIXTURE_ENV, makeSourceRepo, tempDir } from "./fixtures.js";
import { git, gitBare } from "./gitRunner.js";
import { fetchProjectUpdate, missingUpdates, updateAt, updateRef } from "./projectUpdate.js";
import { diffRefs } from "./pushEvents.js";
import { ensureStagingRepo, refSnapshot } from "./staging.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/**
 * A student's repository (`main` at the hand-out), the staging repository
 * mirroring it, and `sync(text)`: the teacher's next update pushed to the
 * student's `sync/main`, as the platform's sync does; its sha.
 */
async function world() {
  const base = await tempDir("p3-update-");
  dirs.push(base);
  const student = await makeSourceRepo({ dir: join(base, "student"), files: { "README.md": "v1\n" } });
  const staging = await ensureStagingRepo({
    volumesRoot: join(base, "volumes"),
    student: "e1",
    assignment: "lab",
    source: { mode: "lab", mirrorFrom: student.gitDir },
  });
  const dist = join(base, "dist");
  await git(["clone", "-q", student.gitDir, dist], { env: FIXTURE_ENV });
  const sync = async (text: string): Promise<string> => {
    await writeFile(join(dist, "README.md"), text, "utf8");
    await git(["-C", dist, "commit", "-qam", "Project update"], { env: FIXTURE_ENV });
    await git(["-C", dist, "push", "-q", "--force", "origin", "HEAD:refs/heads/sync/main"], { env: FIXTURE_ENV });
    return (await git(["-C", dist, "rev-parse", "HEAD"], { env: FIXTURE_ENV })).trim();
  };
  return { base, student, gitDir: staging.gitDir, sync };
}

describe("fetchProjectUpdate", () => {
  it("fetches the commit by sha onto refs/quiz/update/<branch>, moves no branch, does nothing the second time, follows a later sync", async () => {
    const w = await world();
    const sha = await w.sync("v2\n");
    const branchesBefore = [...(await refSnapshot(w.gitDir))];
    let asked = 0;
    const authorize = async () => {
      asked += 1;
      return undefined;
    };

    expect(await updateAt(w.gitDir, "main", sha)).toBe(false);
    expect(await fetchProjectUpdate({ gitDir: w.gitDir, url: w.student.gitDir, heads: [{ branch: "main", sha }], authorize })).toBe("fetched");
    const after = await refSnapshot(w.gitDir);
    expect(after.get(updateRef("main"))).toBe(sha);
    expect(await updateAt(w.gitDir, "main", sha)).toBe(true);
    // Every branch exactly as before: the update is a ref of the portal's only.
    expect([...after].filter(([ref]) => ref.startsWith("refs/heads/"))).toEqual(branchesBefore.filter(([ref]) => ref.startsWith("refs/heads/")));

    // Idempotent: derived from the repository's state, no authorization asked.
    expect(await fetchProjectUpdate({ gitDir: w.gitDir, url: w.student.gitDir, heads: [{ branch: "main", sha }], authorize })).toBe("current");
    expect(asked).toBe(1);

    // A later sync moves it.
    const next = await w.sync("v3\n");
    expect(await missingUpdates(w.gitDir, [{ branch: "main", sha: next }])).toEqual([{ branch: "main", sha: next }]);
    expect(await fetchProjectUpdate({ gitDir: w.gitDir, url: w.student.gitDir, heads: [{ branch: "main", sha: next }] })).toBe("fetched");
    expect(await updateAt(w.gitDir, "main", next)).toBe(true);
    expect(await updateAt(w.gitDir, "main", sha)).toBe(false);
  });

  it("settles the authorization it used; a failed fetch throws and leaves every ref as it was; one fetch at a time", async () => {
    const w = await world();
    const sha = await w.sync("v2\n");
    const settled: string[] = [];
    const before = await refSnapshot(w.gitDir);
    await expect(
      fetchProjectUpdate({
        gitDir: w.gitDir,
        url: join(w.base, "nowhere.git"),
        heads: [{ branch: "main", sha }],
        authorize: async () => "basic secret",
        settle: (a) => void settled.push(a),
      }),
    ).rejects.toThrow();
    expect(settled).toEqual(["basic secret"]);
    expect(await refSnapshot(w.gitDir)).toEqual(before);

    // A commit the repository does not hold (the sync skipped it): refused, nothing written.
    await expect(fetchProjectUpdate({ gitDir: w.gitDir, url: w.student.gitDir, heads: [{ branch: "main", sha: "e".repeat(40) }] })).rejects.toThrow();
    expect(await refSnapshot(w.gitDir)).toEqual(before);

    // Two at once: the second finds the first's work done.
    const both = await Promise.all([
      fetchProjectUpdate({ gitDir: w.gitDir, url: w.student.gitDir, heads: [{ branch: "main", sha }] }),
      fetchProjectUpdate({ gitDir: w.gitDir, url: w.student.gitDir, heads: [{ branch: "main", sha }] }),
    ]);
    expect(both).toEqual(["fetched", "current"]);
  });

  it("refuses a head that is not a branch and a full sha before any git call", async () => {
    const w = await world();
    for (const head of [
      { branch: "main", sha: "HEAD" },
      { branch: "+refs/heads/*", sha: "a".repeat(40) },
      { branch: "-x", sha: "a".repeat(40) },
      { branch: "a/../b", sha: "a".repeat(40) },
    ]) {
      await expect(fetchProjectUpdate({ gitDir: w.gitDir, url: w.student.gitDir, heads: [head] }), head.branch).rejects.toThrow(/invalid update head/);
    }
  });
});

describe("the portal's refs, never a student's", () => {
  it("refuses a student's push to refs/quiz/* — an update, a new name, a deletion — and the staging repository keeps the portal's", async () => {
    const w = await world();
    // Set by the seeding itself, before any update.
    expect(await gitBare(w.gitDir, ["config", "receive.hideRefs"])).toBe("refs/quiz\n");
    const sha = await w.sync("v2\n");
    await fetchProjectUpdate({ gitDir: w.gitDir, url: w.student.gitDir, heads: [{ branch: "main", sha }] });
    const work = join(w.base, "work");
    await git(["clone", "-q", w.gitDir, work], { env: FIXTURE_ENV });
    await git(["-C", work, "commit", "-q", "--allow-empty", "-m", "forged update"], { env: FIXTURE_ENV });
    for (const refspec of ["HEAD:refs/quiz/update/main", "HEAD:refs/quiz/update/other", ":refs/quiz/update/main"]) {
      const err = await git(["-C", work, "push", "origin", refspec], { env: FIXTURE_ENV }).catch((e: Error) => e.message);
      expect(String(err), refspec).toMatch(/hidden ref/);
    }
    expect(await updateAt(w.gitDir, "main", sha)).toBe(true);
    expect((await refSnapshot(w.gitDir)).get("refs/quiz/update/other")).toBeUndefined();
  });

  it("never records the portal's refs as a push: a fetch landing during a student's push is no PushEvent, so never relayed", () => {
    const before = new Map([["refs/heads/main", "a".repeat(40)]]);
    const after = new Map([
      ["refs/heads/main", "b".repeat(40)],
      ["refs/quiz/update/main", "c".repeat(40)],
    ]);
    expect(diffRefs(before, after)).toEqual([{ ref: "refs/heads/main", oldSha: "a".repeat(40), sha: "b".repeat(40) }]);
    expect(diffRefs(after, before)).toEqual([{ ref: "refs/heads/main", oldSha: "b".repeat(40), sha: "a".repeat(40) }]);
  });
});
