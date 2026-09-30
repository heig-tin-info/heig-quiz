/**
 * The journal's ingestion (M4-02; ported from heig-classroom's
 * `journal/ingest.db.test.ts`), on a server built with Quiz's App against the
 * fake GitHub (`github/testing.ts`, `./testing.ts`): no network.
 *
 * What is pinned is the cost model as much as the result — an unchanged page
 * fetches no blob, an asset nothing references is never downloaded — and the
 * port's own fixes: two renderings per page, the root folder and the branch
 * of the classroom's row, errors as codes with the pages kept, and two
 * ingestions of one classroom converging (J2).
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { JOURNAL_ASSET_MAX_BYTES } from "@quiz/contracts";

import { loadConfig, type AppConfig } from "../../config.js";
import { classroomJournals, githubClassroomLinks, githubOrganizations, journalAssets, journalPages } from "../../db/schema.js";
import { subscribe, type BusMessage } from "../../events.js";
import { appKey, fakeGithub, orgsRoute } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { JOURNAL_INGEST_QUEUE, type JobQueue } from "../../jobs.js";
import { ingestJournal } from "./ingest.js";
import { registerJournalJobs } from "./jobs.js";
import { blobSha, pushTo, repoRoute, type FakeFile, type FakeRepo } from "./testing.js";

const key = appKey();
const gh = fakeGithub();
let server: TestServer;
let config: AppConfig;
let teacherId: string;
let repos: FakeRepo[] = [];
let reads: string[] = [];
let onHead: (repo: FakeRepo) => void = () => {};

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  const env = { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY_PATH: key.pem, GITHUB_APP_SLUG: "quiz-test" };
  server = await testServer(env);
  config = loadConfig({ NODE_ENV: "test", ...env });
  teacherId = (await server.signIn("teacher")).id;
  gh.routes = [
    orgsRoute(() => []),
    repoRoute(
      () => repos,
      reads,
      (repo) => onHead(repo),
    ),
  ];
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  key.remove();
});

let nextRepoId = 1000;

/**
 * A classroom linked to an installed organization, with a journal on a new
 * repository of `files` (branch `main`), not yet ingested.
 */
async function world(files: FakeFile[], row: Partial<typeof classroomJournals.$inferInsert> = {}) {
  const db = server.app.db;
  const { classroomId } = await seedLive(db, { teacherId, studentIds: [], questions: 0 });
  const orgId = randomUUID();
  const installationId = nextRepoId * 10;
  await db.insert(githubOrganizations).values({ id: orgId, login: `org-${orgId.slice(0, 6)}`, githubOrgId: installationId, installationId });
  await db.insert(githubClassroomLinks).values({ classroomId, orgId, linkedBy: teacherId, linkedAt: new Date() });
  const repo: FakeRepo = { id: nextRepoId++, owner: "heig-prg", name: `journal-${classroomId.slice(0, 6)}`, branches: { main: { commit: "c1".padEnd(40, "0"), files } } };
  repos.push(repo);
  await db.insert(classroomJournals).values({
    classroomId,
    githubRepoId: repo.id,
    fullName: `heig-prg/${repo.name}`,
    ref: "main",
    createdBy: teacherId,
    ...row,
  });
  return { classroomId, repo, orgId, ingest: () => ingestJournal(server.app, config, classroomId) };
}

const push = (repo: FakeRepo, files: FakeFile[]) => pushTo(repo, files);

const pagesOf = (classroomId: string) =>
  server.app.db.select().from(journalPages).where(eq(journalPages.classroomId, classroomId)).orderBy(journalPages.path);

const assetsOf = (classroomId: string) =>
  server.app.db.select().from(journalAssets).where(eq(journalAssets.classroomId, classroomId)).orderBy(journalAssets.path);

async function rowOf(classroomId: string) {
  const [row] = await server.app.db.select().from(classroomJournals).where(eq(classroomJournals.classroomId, classroomId));
  return row!;
}

describe("ingestJournal", () => {
  it("copies the pages of the repository, titled and placed, rendered twice", async () => {
    const w = await world([
      { path: "README.md", content: "# The course\n" },
      { path: "010-basics/README.md", content: "---\ntitle: Basics\n---\nIntro\n" },
      { path: "010-basics/020-pointers.md", content: "## A heading\n" },
      { path: "Makefile", content: "all:\n" },
    ]);
    expect(await w.ingest()).toMatchObject({ status: "ok", pages: 3, assets: 0 });
    const pages = await pagesOf(w.classroomId);
    expect(pages.map((p) => [p.path, p.title, p.parentPath])).toEqual([
      ["010-basics/020-pointers.md", "Pointers", "010-basics"],
      ["010-basics/README.md", "Basics", "010-basics"],
      ["README.md", "The course", ""],
    ]);
    for (const page of pages) {
      expect(page.htmlStaff).not.toBe("");
      expect(page.htmlStudent).toBe(page.htmlStaff); // nothing hidden, nothing differs
    }
  });

  it("stores the markdown without NUL, as the renderer cleans it", async () => {
    const w = await world([{ path: "README.md", content: "# A\u0000B\n" }]);
    await w.ingest();
    expect((await pagesOf(w.classroomId))[0]!.markdown).toBe("# AB\n");
  });

  it("records the commit it was built from, the repository's name, and success", async () => {
    const w = await world([{ path: "README.md", content: "# A\n" }], { fullName: "heig-prg/old-name" });
    await w.ingest();
    expect(await rowOf(w.classroomId)).toMatchObject({
      syncStatus: "ok",
      syncError: null,
      lastCommitSha: w.repo.branches.main!.commit,
      // Found by its id: a rename GitHub never told us about is followed too.
      fullName: `heig-prg/${w.repo.name}`,
    });
    expect((await rowOf(w.classroomId)).lastSyncedAt).not.toBeNull();
  });

  it("fetches no blob for a page whose sha did not move", async () => {
    const same: FakeFile = { path: "README.md", content: "# A\n" };
    const w = await world([same, { path: "010-b.md", content: "# B\n" }]);
    await w.ingest();
    const edited: FakeFile = { path: "010-b.md", content: "# B revised\n" };
    push(w.repo, [same, edited]);
    reads.length = 0;
    await w.ingest();
    expect(reads).toEqual([blobSha(edited)]);
    expect((await pagesOf(w.classroomId)).find((p) => p.path === "010-b.md")!.title).toBe("B revised");
  });

  it("re-renders every page, so a link to a new page stops being dead", async () => {
    const home: FakeFile = { path: "README.md", content: "See [later](./010-later.md)\n" };
    const w = await world([home]);
    await w.ingest();
    let [page] = await pagesOf(w.classroomId);
    expect(page!.htmlStaff).not.toContain("<a ");
    expect(page!.warnings).toEqual([{ code: "target_missing", href: "./010-later.md", path: "010-later.md" }]);

    push(w.repo, [home, { path: "010-later.md", content: "# Later\n" }]);
    await w.ingest();
    [page] = (await pagesOf(w.classroomId)).filter((p) => p.path === "README.md");
    expect(page!.htmlStaff).toContain('href="./010-later.md"');
    expect(page!.htmlStudent).toContain('href="./010-later.md"');
    expect(page!.warnings).toEqual([]);
  });

  it("links a draft and a future page for the staff only", async () => {
    const w = await world([
      { path: "README.md", content: "[d](010-draft.md) [f](020-future.md) [o](030-open.md)\n" },
      { path: "010-draft.md", content: "---\ndraft: true\n---\n# Soon\n" },
      { path: "020-future.md", content: "---\nvisible_from: 2099-01-01\n---\n# Later\n" },
      { path: "030-open.md", content: "# Now\n" },
    ]);
    await w.ingest();
    const pages = await pagesOf(w.classroomId);
    expect(pages.map((p) => [p.path, p.draft, p.visibleFrom !== null])).toEqual([
      ["010-draft.md", true, false],
      ["020-future.md", false, true],
      ["030-open.md", false, false],
      ["README.md", false, false],
    ]);
    const home = pages.find((p) => p.path === "README.md")!;
    expect(home.htmlStaff).toContain('href="./010-draft.md"');
    expect(home.htmlStaff).toContain('href="./020-future.md"');
    expect(home.htmlStudent).not.toContain("010-draft");
    expect(home.htmlStudent).not.toContain("020-future");
    expect(home.htmlStudent).toContain('href="./030-open.md"');
    expect((await rowOf(w.classroomId)).studentRenderedAt).not.toBeNull();
  });

  it("downloads only the assets a page references, and records them on the page", async () => {
    const used: FakeFile = { path: "images/used.png", content: "PNG-BYTES" };
    const w = await world([
      { path: "README.md", content: "![p](images/used.png)\n" },
      used,
      { path: "images/unused.png", content: "NEVER-READ" },
      { path: ".github/logo.png", content: "FURNITURE" },
    ]);
    reads.length = 0;
    expect(await w.ingest()).toMatchObject({ assets: 1 });
    expect(reads).toContain(blobSha(used));
    expect(reads).toHaveLength(2); // the page and the one asset
    const cached = await assetsOf(w.classroomId);
    expect(cached.map((a) => [a.path, a.contentType, Buffer.from(a.data).toString()])).toEqual([
      ["images/used.png", "image/png", "PNG-BYTES"],
    ]);
    expect((await pagesOf(w.classroomId))[0]!.assetPaths).toEqual(["images/used.png"]);
  });

  it("neither serves nor links a file over the size cap, and says why", async () => {
    const w = await world([
      { path: "README.md", content: "![big](images/big.png)\n" },
      { path: "images/big.png", content: "x", size: JOURNAL_ASSET_MAX_BYTES + 1 },
    ]);
    await w.ingest();
    const [home] = await pagesOf(w.classroomId);
    expect(home!.htmlStaff).not.toContain("<img");
    expect(home!.warnings).toEqual([{ code: "asset_too_large", href: "images/big.png", path: "images/big.png" }]);
    expect(await assetsOf(w.classroomId)).toHaveLength(0);
  });

  it("drops what the repository no longer holds, and keeps a page's id", async () => {
    const w = await world([
      { path: "README.md", content: "![p](images/p.png)\n" },
      { path: "010-gone.md", content: "# Gone\n" },
      { path: "images/p.png", content: "BYTES" },
    ]);
    await w.ingest();
    const id = (await pagesOf(w.classroomId)).find((p) => p.path === "README.md")!.id;
    push(w.repo, [{ path: "README.md", content: "Nothing left\n" }]);
    await w.ingest();
    const pages = await pagesOf(w.classroomId);
    expect(pages.map((p) => [p.path, p.id])).toEqual([["README.md", id]]);
    expect(await assetsOf(w.classroomId)).toHaveLength(0);
  });

  it("empties the copy of a repository with no commit, without failing", async () => {
    const w = await world([{ path: "README.md", content: "# A\n" }]);
    await w.ingest();
    w.repo.branches = {};
    expect(await w.ingest()).toMatchObject({ status: "ok", pages: 0, commitSha: null });
    expect(await pagesOf(w.classroomId)).toHaveLength(0);
    expect(await rowOf(w.classroomId)).toMatchObject({ syncStatus: "ok", lastCommitSha: null });
  });

  it.each([
    ["a truncated tree", (r: FakeRepo): void => {
      r.truncated = true;
    }, "too_large"],
    ["a deleted repository", (r: FakeRepo): void => {
      r.exists = false;
    }, "repo_not_found"],
    ["a branch that is gone", (r: FakeRepo): void => {
      r.branches = { other: r.branches.main! };
    }, "ref_not_found"],
    ["GitHub failing", (r: FakeRepo): void => {
      r.failWith = 502;
    }, "github_unavailable"],
    ["GitHub refusing", (r: FakeRepo): void => {
      r.failWith = 403;
    }, "forbidden"],
  ] as const)("records %s as an error and keeps the pages", async (_name, breakIt, code) => {
    const w = await world([{ path: "README.md", content: "# A\n" }]);
    await w.ingest();
    const before = await pagesOf(w.classroomId);
    breakIt(w.repo);
    expect(await w.ingest()).toEqual({ status: "error", code });
    expect(await rowOf(w.classroomId)).toMatchObject({ syncStatus: "error", syncError: code });
    // The classroom keeps reading what was last copied.
    expect(await pagesOf(w.classroomId)).toEqual(before);
  });

  it("reports an organization without installation instead of calling GitHub", async () => {
    const w = await world([{ path: "README.md", content: "# A\n" }]);
    await server.app.db.update(githubOrganizations).set({ installationId: null }).where(eq(githubOrganizations.id, w.orgId));
    const calls = gh.calls.length;
    expect(await w.ingest()).toEqual({ status: "error", code: "forbidden" });
    expect(gh.calls.length).toBe(calls);
  });

  it("honours the root folder of the row, and says when it is gone", async () => {
    const w = await world(
      [
        { path: "docs/README.md", content: "# The course\n![p](images/p.png)\n" },
        { path: "README.md", content: "# The repository\n" },
        { path: "docs/images/p.png", content: "BYTES" },
      ],
      { rootPath: "docs" },
    );
    await w.ingest();
    const pages = await pagesOf(w.classroomId);
    expect(pages.map((p) => [p.path, p.title])).toEqual([["README.md", "The course"]]);
    expect((await assetsOf(w.classroomId)).map((a) => a.path)).toEqual(["images/p.png"]);

    push(w.repo, [{ path: "README.md", content: "# Moved out\n" }]);
    expect(await w.ingest()).toEqual({ status: "error", code: "root_not_found" });
    expect((await pagesOf(w.classroomId)).map((p) => p.title)).toEqual(["The course"]);
  });

  it("follows the branch of the row", async () => {
    const w = await world([{ path: "README.md", content: "# Main\n" }], { ref: "2025-autumn" });
    w.repo.branches["2025-autumn"] = { commit: "a".repeat(40), files: [{ path: "README.md", content: "# Last year\n" }] };
    await w.ingest();
    expect((await pagesOf(w.classroomId))[0]!.title).toBe("Last year");
  });

  it("tells the classroom's readers to refresh", async () => {
    const w = await world([{ path: "README.md", content: "# A\n" }]);
    const seen: BusMessage[] = [];
    const off = subscribe((e) => seen.push(e));
    try {
      await w.ingest();
    } finally {
      off();
    }
    expect(seen).toContainEqual({ kind: "hint", type: "journal", topics: [`classroom:${w.classroomId}`] });
  });

  it("is a no-op on a classroom without a journal", async () => {
    expect(await ingestJournal(server.app, config, randomUUID())).toBeNull();
  });

  it("is worked by the queue, which retries only when GitHub was unavailable", async () => {
    const w = await world([{ path: "README.md", content: "# A\n" }]);
    let work: ((job: { classroomId: string }) => Promise<void>) | undefined;
    const queue = {
      createQueue: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      work: vi.fn(async (_name: string, handler: (job: { classroomId: string }) => Promise<void>) => {
        work = handler;
      }),
      stop: vi.fn(async () => {}),
    } as unknown as JobQueue;
    await registerJournalJobs(server.app, queue, config);
    expect(queue.createQueue).toHaveBeenCalledWith(JOURNAL_INGEST_QUEUE, { retryLimit: 3, retryBackoff: true, retryDelay: 20 });
    await work!({ classroomId: w.classroomId });
    expect((await rowOf(w.classroomId)).syncStatus).toBe("ok");
    w.repo.failWith = 503;
    await expect(work!({ classroomId: w.classroomId })).rejects.toThrow(/GitHub unavailable/);
    // A refusal is the staff's to fix: recorded, not retried.
    w.repo.failWith = 403;
    await expect(work!({ classroomId: w.classroomId })).resolves.toBeUndefined();
    expect((await rowOf(w.classroomId)).syncError).toBe("forbidden");
  });

  it("converges when two ingestions of one classroom run at once (J2)", async () => {
    const w = await world([{ path: "README.md", content: "# First\n" }]);
    // The repository moves on right after the first ingestion read its head.
    let moved = false;
    let second = "";
    onHead = (repo) => {
      if (repo !== w.repo || moved) return;
      moved = true;
      second = push(repo, [
        { path: "README.md", content: "# Second\n" },
        { path: "010-new.md", content: "# New\n" },
      ]);
    };
    try {
      const outcomes = await Promise.all([w.ingest(), w.ingest()]);
      expect(outcomes.every((o) => o?.status === "ok")).toBe(true);
    } finally {
      onHead = () => {};
    }
    expect((await rowOf(w.classroomId)).lastCommitSha).toBe(second);
    expect((await pagesOf(w.classroomId)).map((p) => [p.path, p.title])).toEqual([
      ["010-new.md", "New"],
      ["README.md", "Second"],
    ]);
  });
});
