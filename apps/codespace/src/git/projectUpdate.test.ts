/**
 * The teacher's update in a staging repository (ADR-132 §11), on real git:
 * fetched by sha onto `refs/quiz/update/<branch>`, no branch moved,
 * idempotent, moved by a later sync; set from the repository's own objects
 * with no token and no network when it holds the commit; a failure leaving
 * the ref as it was; the portal's refs never a `PushEvent`. The orchestration
 * (start, sync, refusals) is `sessions/workspace.test.ts`'s; a student's push
 * to `refs/quiz/*` through the channel, `httpBackend.test.ts`'s.
 */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { FIXTURE_ENV, makeSourceRepo, tempDir } from "./fixtures.js";
import { git, gitBare } from "./gitRunner.js";
import { fetchProjectUpdate, updateAt, updateRef } from "./projectUpdate.js";
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

const heads = async (gitDir: string) => [...(await refSnapshot(gitDir))].filter(([ref]) => ref.startsWith("refs/heads/"));

describe("fetchProjectUpdate", () => {
  it("fetches the commit by sha onto refs/quiz/update/<branch>, moves no branch, does nothing the second time, follows a later sync", async () => {
    const w = await world();
    const sha = await w.sync("v2\n");
    const branches = await heads(w.gitDir);
    let asked = 0;
    const authorize = async () => {
      asked += 1;
      return undefined;
    };
    const fetch = (s: string) => fetchProjectUpdate({ gitDir: w.gitDir, url: w.student.gitDir, head: { branch: "main", sha: s }, authorize });

    expect(await fetch(sha)).toBe("fetched");
    expect(await updateAt(w.gitDir, "main", sha)).toBe(true);
    expect(await heads(w.gitDir)).toEqual(branches);
    expect(await gitBare(w.gitDir, ["config", "receive.hideRefs"])).toBe("refs/quiz\n");
    expect(await fetch(sha)).toBe("current");
    expect(asked).toBe(1);

    const next = await w.sync("v3\n");
    expect(await fetch(next)).toBe("fetched");
    expect(await updateAt(w.gitDir, "main", next)).toBe(true);
    expect(await updateAt(w.gitDir, "main", sha)).toBe(false);
  });

  it("sets the ref from the repository's own objects with no token and no network, when it holds the commit", async () => {
    const w = await world();
    // The repository holds the hand-out's commit (its `main`); the forge is gone.
    const [[, held]] = (await heads(w.gitDir)) as [[string, string]];
    await rm(w.student.gitDir, { recursive: true, force: true });
    const outcome = await fetchProjectUpdate({
      gitDir: w.gitDir,
      url: w.student.gitDir,
      head: { branch: "main", sha: held },
      authorize: async () => {
        throw new Error("no token may be asked");
      },
    });
    expect(outcome).toBe("local");
    expect(await updateAt(w.gitDir, "main", held)).toBe(true);
  });

  it("settles the authorization it used; a failure throws and leaves the ref as it was; one call at a time", async () => {
    const w = await world();
    const sha = await w.sync("v2\n");
    const settled: string[] = [];
    await expect(
      fetchProjectUpdate({
        gitDir: w.gitDir,
        url: join(w.base, "nowhere.git"),
        head: { branch: "main", sha },
        authorize: async () => "basic secret",
        settle: (a) => void settled.push(a),
      }),
    ).rejects.toThrow();
    expect(settled).toEqual(["basic secret"]);
    expect(await updateAt(w.gitDir, "main", sha)).toBe(false);

    // A commit the student's repository does not hold (the sync skipped it): refused, nothing written.
    await expect(fetchProjectUpdate({ gitDir: w.gitDir, url: w.student.gitDir, head: { branch: "main", sha: "e".repeat(40) } })).rejects.toThrow();
    expect((await refSnapshot(w.gitDir)).get(updateRef("main"))).toBeUndefined();

    const both = await Promise.all([
      fetchProjectUpdate({ gitDir: w.gitDir, url: w.student.gitDir, head: { branch: "main", sha } }),
      fetchProjectUpdate({ gitDir: w.gitDir, url: w.student.gitDir, head: { branch: "main", sha } }),
    ]);
    expect(both).toEqual(["fetched", "current"]);
  });

  it("refuses anything but a full sha before any git call", async () => {
    const w = await world();
    for (const sha of ["HEAD", "main", "--upload-pack=x", "a".repeat(39)]) {
      await expect(fetchProjectUpdate({ gitDir: w.gitDir, url: w.student.gitDir, head: { branch: "main", sha } }), sha).rejects.toThrow(/invalid update sha/);
    }
  });
});

describe("the portal's refs, never a push", () => {
  it("never records them: a fetch landing during a student's push is no PushEvent, so never relayed", () => {
    const before = new Map([["refs/heads/main", "a".repeat(40)]]);
    const after = new Map([
      ["refs/heads/main", "b".repeat(40)],
      ["refs/quiz/update/main", "c".repeat(40)],
    ]);
    expect(diffRefs(before, after)).toEqual([{ ref: "refs/heads/main", oldSha: "a".repeat(40), sha: "b".repeat(40) }]);
    expect(diffRefs(after, before)).toEqual([{ ref: "refs/heads/main", oldSha: "b".repeat(40), sha: "a".repeat(40) }]);
  });
});
