/**
 * The journal's writes (M4-03), on a server built with Quiz's App, against
 * the fake GitHub (`github/testing.ts`, `./testing.ts`), no network:
 *
 * - create (a private repository, its README, never an adoption: a name
 *   taken is a 409 with a free name), use (any repository of the
 *   organization, its branch and root folder honoured, another's refused),
 *   remove (the repository kept; D28's disconnect unblocked), refresh, preview;
 * - GitHub mode read-only (ADR-057): save, add, delete and upload refused
 *   with 409 `read_only`, nothing committed nor copied; every staff page
 *   carries its github.com edit link;
 * - the invitations (D27): `push` only, one audit entry each, a refusal never
 *   failing the creation;
 * - who may write: the staff; a student, a teacher off the staff get the 404
 *   of a missing classroom, an impersonation session 403, a `seb` or `kiosk`
 *   session is nobody.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Journal,
  JOURNAL_ASSET_MAX_BYTES,
  JOURNAL_MARKDOWN_MAX,
  JournalNameTaken,
  JournalPreviewResult,
  JournalRefusal,
  type JournalStaff,
} from "@quiz/contracts";

import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "../../auth/session.js";
import {
  auditLog,
  classroomJournals,
  courseStaff,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  journalPages,
} from "../../db/schema.js";
import { appKey, fakeGithub, orgsRoute } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { kioskStation } from "../../test/kiosk.js";
import { seedLive } from "../../test/live.js";
import { blobSha, fakeWorld, pushTo, repoRoute, writeRoute, type FakeFile, type FakeRepo } from "./testing.js";

const key = appKey();
const gh = fakeGithub();
const world = fakeWorld();
const ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
  GITHUB_APP_SLUG: "quiz-test",
  GITHUB_WEBHOOK_SECRET: "w".repeat(40),
};
let server: TestServer;

type Headers = Record<string, string>;
let teacher: { id: string; headers: Headers };
let colleague: { id: string; headers: Headers };
let outsider: { id: string; headers: Headers };
let student: { id: string; headers: Headers };

let nextId = 7000;

/** A classroom of `teacher`'s course (and `colleague`'s), connected to an installed organization. */
async function connectedClassroom(opts: { connected?: boolean } = {}) {
  const db = server.app.db;
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });
  await db.insert(courseStaff).values({ courseId: seeded.courseId, userId: colleague.id });
  const n = nextId++;
  const login = `org-${n}`;
  world.orgIds[login] = n;
  if (opts.connected !== false) {
    const orgId = randomUUID();
    await db.insert(githubOrganizations).values({ id: orgId, login, githubOrgId: n, installationId: n });
    await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId, linkedBy: teacher.id, linkedAt: new Date() });
  }
  return { id: seeded.classroomId, login, courseId: seeded.courseId };
}

/** A repository of `owner` with `files` on `branch`. */
function repoOf(owner: string, name: string, files: FakeFile[], branch = "main"): FakeRepo {
  const repo: FakeRepo = { id: nextId++, owner, ownerId: world.orgIds[owner] ?? 0, name, branches: {}, defaultBranch: "main" };
  pushTo(repo, files, branch);
  world.repos.push(repo);
  return repo;
}

const base = (id: string) => `/app/api/classrooms/${id}/journal`;
const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, headers: Headers, payload?: unknown) =>
  server.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

const rowOf = async (id: string) =>
  (await server.app.db.select().from(classroomJournals).where(eq(classroomJournals.classroomId, id)))[0];

const auditOf = (id: string, action: string) =>
  server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.subjectId, id), eq(auditLog.action, action)));

const commitsTo = (fullName: string) => world.commits.filter((c) => c.repo === fullName);

/** A classroom with a journal on a fresh repository, its copy synchronised. */
async function withJournal(files: FakeFile[] = [{ path: "README.md", content: "# Home\n" }]) {
  const room = await connectedClassroom();
  const repo = repoOf(room.login, `journal-${nextId++}`, files);
  const res = await call("POST", `${base(room.id)}/use`, teacher.headers, { name: repo.name });
  expect(res.statusCode, res.body).toBe(201);
  return { room, repo, fullName: `${repo.owner}/${repo.name}` };
}

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => []), writeRoute(world), repoRoute(() => world.repos)];
  [teacher, colleague, outsider, student] = await Promise.all([
    server.signIn("teacher"),
    server.signIn("teacher"),
    server.signIn("teacher"),
    server.signIn("student"),
  ]);
  // The teacher linked GitHub; the colleague did not.
  await server.app.db.insert(githubAccounts).values({ userId: teacher.id, githubUserId: 501, login: "prof" });
  world.accounts.set(501, "prof");
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  key.remove();
});

// ---------------------------------------------------------------- create

describe("create a journal (F-JRN-02)", () => {
  it("creates a private repository with its README, invites, and reads it in", async () => {
    const room = await connectedClassroom();
    const res = await call("POST", base(room.id), teacher.headers);
    expect(res.statusCode, res.body).toBe(201);
    const journal = Journal.parse(res.json()) as JournalStaff;
    const fullName = `${room.login}/a-journal`;
    // A created journal lives on GitHub, read-only in the platform (ADR-057).
    expect(journal.mode).toBe("github");
    expect(journal.repository).toMatchObject({ fullName, ref: "main", rootPath: "", syncStatus: "ok", editable: false });
    expect(journal.homePath).toBe("README.md");
    expect(gh.calls).toContain(`POST api.github.com/orgs/${room.login}/repos`);
    const created = gh.inits[gh.calls.lastIndexOf(`POST api.github.com/orgs/${room.login}/repos`)]!;
    expect(JSON.parse(created.body as string)).toMatchObject({ name: "a-journal", private: true, auto_init: false });
    const [readme] = commitsTo(fullName);
    expect(readme).toMatchObject({ method: "PUT", path: "README.md", branch: "main", author: { name: "Test teacher", email: "501+prof@users.noreply.github.com" } });
    // The committer stays the App: GitHub signs the commit.
    expect(readme!.committer).toBeUndefined();
    expect(await rowOf(room.id)).toMatchObject({ mode: "github", fullName, ref: "main", rootPath: "", createdBy: teacher.id });
    const audited = await auditOf(room.id, "journal.create");
    expect(audited).toHaveLength(1);
    expect(audited[0]!.payload).toMatchObject({ mode: "github", fullName });
  });

  it("takes the name the teacher chose", async () => {
    const room = await connectedClassroom();
    const res = await call("POST", base(room.id), teacher.headers, { name: "prog-c-journal" });
    expect(res.statusCode, res.body).toBe(201);
    expect((await rowOf(room.id))!.fullName).toBe(`${room.login}/prog-c-journal`);
  });

  it("never adopts a repository on a name taken: 409 with a free name, nothing written", async () => {
    const room = await connectedClassroom();
    const taken = repoOf(room.login, "a-journal", [{ path: "README.md", content: "# Someone else's course\n" }]);
    const before = world.commits.length;
    const res = await call("POST", base(room.id), teacher.headers);
    expect(res.statusCode).toBe(409);
    const refusal = JournalNameTaken.parse(res.json());
    const short = room.id.replace(/-/g, "").slice(0, 8);
    expect(refusal.suggestion).toBe(`a-journal-${short}`);
    expect(await rowOf(room.id)).toBeUndefined();
    expect(world.commits.length).toBe(before);
    expect(taken.branches.main!.files.map((f) => f.path)).toEqual(["README.md"]);

    // The suggestion taken too: the whole id, still deterministic.
    repoOf(room.login, `a-journal-${short}`, [{ path: "README.md", content: "x" }]);
    const again = JournalNameTaken.parse((await call("POST", base(room.id), teacher.headers)).json());
    expect(again.suggestion).toBe(`a-journal-${room.id.replace(/-/g, "")}`);
  });

  it("refuses a classroom that already has a journal, or is not connected", async () => {
    const { room } = await withJournal();
    const twice = await call("POST", base(room.id), teacher.headers);
    expect([twice.statusCode, JournalRefusal.parse(twice.json()).error]).toEqual([409, "journal_exists"]);
    const loose = await connectedClassroom({ connected: false });
    const res = await call("POST", base(loose.id), teacher.headers);
    expect([res.statusCode, res.json().error]).toEqual([409, "not_connected"]);
  });

  it("refuses a name GitHub would not take", async () => {
    const room = await connectedClassroom();
    // One case: the matrix is the contracts' (`journal.test.ts`).
    expect((await call("POST", base(room.id), teacher.headers, { name: ".." })).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------- invitations

describe("the invitations (D27)", () => {
  it("invites the linked staff with push only, each audited, and a refusal fails nothing", async () => {
    const room = await connectedClassroom();
    // The colleague links an account GitHub refuses; a third member's account is gone.
    const gone = await server.signIn("teacher");
    await server.app.db.insert(courseStaff).values({ courseId: room.courseId, userId: gone.id });
    await server.app.db.insert(githubAccounts).values([
      { userId: colleague.id, githubUserId: 502, login: "colleague" },
      { userId: gone.id, githubUserId: 503, login: "ghost" },
    ]);
    world.accounts.set(502, "colleague");
    world.refused.add("colleague");
    try {
      const res = await call("POST", base(room.id), teacher.headers, { name: "invited-journal" });
      expect(res.statusCode, res.body).toBe(201);
    } finally {
      await server.app.db.delete(githubAccounts).where(eq(githubAccounts.userId, colleague.id));
      world.refused.delete("colleague");
    }
    const fullName = `${room.login}/invited-journal`;
    expect(world.invitations.filter((i) => i.repo === fullName)).toEqual([{ repo: fullName, login: "prof", permission: "push" }]);
    const entries = await auditOf(room.id, "journal.invite");
    const outcomes = Object.fromEntries(
      entries.map((e) => {
        const p = e.payload as { userId: string; outcome: string; permission: string };
        expect(p.permission).toBe("push");
        expect(e.actorUserId).toBe(teacher.id);
        return [p.userId, p.outcome];
      }),
    );
    expect(outcomes).toEqual({ [teacher.id]: "pending", [colleague.id]: "failed", [gone.id]: "stale" });
    // Every request bounded: a deadline on each.
    const invite = gh.inits[gh.calls.lastIndexOf(`PUT api.github.com/repos/${fullName}/collaborators/prof`)]!;
    expect(invite.signal).toBeInstanceOf(AbortSignal);
  });

  it("leaves a collaborator who already holds more than push as they are", async () => {
    const room = await connectedClassroom();
    const repo = repoOf(room.login, `admin-held-${nextId++}`, [{ path: "README.md", content: "# Home\n" }]);
    const fullName = `${repo.owner}/${repo.name}`;
    world.collaborators.set(fullName, new Map([["prof", "admin"]]));
    const res = await call("POST", `${base(room.id)}/use`, teacher.headers, { name: repo.name });
    expect(res.statusCode, res.body).toBe(201);
    expect(world.invitations.filter((i) => i.repo === fullName)).toEqual([]);
    expect(gh.calls).not.toContain(`PUT api.github.com/repos/${fullName}/collaborators/prof`);
    const [entry] = await auditOf(room.id, "journal.invite");
    expect(entry!.payload).toMatchObject({ userId: teacher.id, login: "prof", permission: "push", outcome: "accepted" });
  });
});

// ---------------------------------------------------------------- use

describe("use a repository of the organization (F-JRN-03)", () => {
  it("honours the branch and the root folder", async () => {
    const room = await connectedClassroom();
    const repo = repoOf(room.login, "shared-notes", [
      { path: "README.md", content: "# Not the journal\n" },
      { path: "docs/README.md", content: "# Course notes\n" },
      { path: "docs/010-intro.md", content: "# Intro\n" },
    ], "course");
    const res = await call("POST", `${base(room.id)}/use`, teacher.headers, { name: repo.name, ref: "course", rootPath: "/docs/" });
    expect(res.statusCode, res.body).toBe(201);
    const journal = Journal.parse(res.json()) as JournalStaff;
    expect(journal.repository).toMatchObject({ fullName: `${room.login}/shared-notes`, ref: "course", rootPath: "docs", syncStatus: "ok" });
    expect(journal.nav.map((n) => n.path)).toEqual(["010-intro.md"]);
    expect((await auditOf(room.id, "journal.use"))[0]!.payload).toMatchObject({ ref: "course", rootPath: "docs", githubRepoId: repo.id });
    expect(world.invitations.some((i) => i.repo === `${room.login}/shared-notes` && i.login === "prof")).toBe(true);
  });

  it("refuses a repository the organization does not hold: missing, or another's", async () => {
    const room = await connectedClassroom();
    const foreign = repoOf("other-org", "their-journal", [{ path: "README.md", content: "# Theirs\n" }]);
    foreign.ownerId = 424242;
    // GitHub still resolves the old name of a repository transferred away.
    foreign.formerly = `${room.login}/moved-away`;
    for (const name of ["moved-away", "nothing-here"]) {
      const res = await call("POST", `${base(room.id)}/use`, teacher.headers, { name });
      expect([res.statusCode, res.json().error], name).toEqual([409, "repo_not_found"]);
    }
    expect(await rowOf(room.id)).toBeUndefined();
  });

  it("refuses a branch or a folder that is not one", async () => {
    const room = await connectedClassroom();
    // One case each: the matrices are the contracts' (`journal.test.ts`).
    expect((await call("POST", `${base(room.id)}/use`, teacher.headers, { name: "n", ref: "-x" })).statusCode).toBe(400);
    expect((await call("POST", `${base(room.id)}/use`, teacher.headers, { name: "n", rootPath: ".github" })).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------- remove, refresh, preview

describe("remove the journal (F-JRN-04)", () => {
  it("drops the copy, keeps the repository, and lets the classroom disconnect (D28)", async () => {
    const { room, repo } = await withJournal();
    const refused = await call("DELETE", `/app/api/classrooms/${room.id}/github`, teacher.headers);
    expect([refused.statusCode, refused.json().error]).toEqual([409, "journal_attached"]);

    const calls = gh.calls.length;
    expect((await call("DELETE", base(room.id), teacher.headers)).statusCode).toBe(204);
    expect(gh.calls.length).toBe(calls); // nothing asked of GitHub
    expect(await rowOf(room.id)).toBeUndefined();
    expect(await server.app.db.select().from(journalPages).where(eq(journalPages.classroomId, room.id))).toEqual([]);
    expect(world.repos).toContain(repo);
    expect(repo.exists).not.toBe(false);
    expect(await auditOf(room.id, "journal.remove")).toHaveLength(1);
    // Idempotent, and audited once.
    expect((await call("DELETE", base(room.id), teacher.headers)).statusCode).toBe(204);
    expect(await auditOf(room.id, "journal.remove")).toHaveLength(1);

    expect((await call("DELETE", `/app/api/classrooms/${room.id}/github`, teacher.headers)).statusCode).toBe(204);
  });
});

describe("refresh (F-JRN-05)", () => {
  it("answers 202 and no body, synchronises the copy (here without a queue), and audits it", async () => {
    const { room, repo } = await withJournal();
    const head = pushTo(repo, [{ path: "README.md", content: "# Moved\n" }]);
    const res = await call("POST", `${base(room.id)}/refresh`, teacher.headers);
    expect([res.statusCode, res.body]).toEqual([202, ""]);
    expect((await rowOf(room.id))!.lastCommitSha).toBe(head);
    expect(await auditOf(room.id, "journal.refresh")).toHaveLength(1);
  });

  it("refuses a classroom without a journal", async () => {
    const room = await connectedClassroom();
    const res = await call("POST", `${base(room.id)}/refresh`, teacher.headers);
    expect([res.statusCode, res.json().error]).toEqual([409, "no_journal"]);
  });
});

describe("preview", () => {
  it("renders with the staff's links, capped, and stores nothing", async () => {
    const { room } = await withJournal([
      { path: "README.md", content: "# Home\n" },
      { path: "010-draft.md", content: "---\ndraft: true\n---\n# Draft\n" },
    ]);
    const before = await rowOf(room.id);
    const calls = gh.calls.length;
    const markdown = "---\ntitle: Soon\n---\n# Soon\n\n[d](010-draft.md) [m](missing.md) <b>x</b>\n";
    const res = await call("POST", `${base(room.id)}/preview`, teacher.headers, { path: "020-soon.md", markdown });
    expect(res.statusCode, res.body).toBe(200);
    const preview = JournalPreviewResult.parse(res.json());
    expect(preview.title).toBe("Soon");
    expect(preview.html).toContain('href="./010-draft.md"');
    expect(preview.warnings.map((w) => w.code).sort()).toEqual(["raw_html", "target_missing"]);
    expect(await rowOf(room.id)).toEqual(before);
    expect(gh.calls.length).toBe(calls);
    const pages = await server.app.db.select().from(journalPages).where(eq(journalPages.classroomId, room.id));
    expect(pages.map((p) => p.path).sort()).toEqual(["010-draft.md", "README.md"]);

    const long = await call("POST", `${base(room.id)}/preview`, teacher.headers, { path: "x.md", markdown: "a".repeat(JOURNAL_MARKDOWN_MAX + 1) });
    expect(long.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------- GitHub mode is read-only (ADR-057)

describe("the content of a GitHub-mode journal is read-only (ADR-057)", () => {
  const upload = (id: string, path: string, body: Buffer, type: string) =>
    server.app.inject({ method: "POST", url: `${base(id)}/assets/${path}`, headers: { ...teacher.headers, "content-type": type }, payload: body });

  it("refuses a save, an add, a delete and an upload with 409 read_only, and writes nothing", async () => {
    const { room, repo, fullName } = await withJournal([
      { path: "README.md", content: "# Home\n" },
      { path: "010-old.md", content: "# Old\n" },
    ]);
    const commits = commitsTo(fullName).length;
    const row = await rowOf(room.id);
    const pages = await server.app.db.select().from(journalPages).where(eq(journalPages.classroomId, room.id));

    const refused = [
      await call("PUT", `${base(room.id)}/pages/README.md`, teacher.headers, {
        markdown: "# Mine\n",
        baseSha: blobSha({ path: "README.md", content: "# Home\n" }),
      }),
      await call("POST", `${base(room.id)}/pages`, teacher.headers, { path: "020-new.md", title: "New" }),
      await call("DELETE", `${base(room.id)}/pages/010-old.md`, teacher.headers),
      await call("DELETE", `${base(room.id)}/pages/030-missing.md`, teacher.headers),
      await upload(room.id, "img/figure.png", Buffer.from("PNG-BYTES"), "image/png"),
    ];
    for (const res of refused) {
      expect([res.statusCode, JournalRefusal.parse(res.json()).error], res.body).toEqual([409, "read_only"]);
    }

    expect(commitsTo(fullName).length).toBe(commits);
    expect(repo.branches.main!.files.map((f) => f.path)).toEqual(["README.md", "010-old.md"]);
    expect(await rowOf(room.id)).toEqual(row);
    expect(await server.app.db.select().from(journalPages).where(eq(journalPages.classroomId, room.id))).toEqual(pages);
    for (const action of ["journal.save", "journal.add", "journal.delete", "journal.upload"]) {
      expect(await auditOf(room.id, action), action).toEqual([]);
    }
  });

  it("is read-only in the staff payload, every page carrying its link to GitHub's editor", async () => {
    const { room, fullName } = await withJournal();
    const journal = Journal.parse((await call("GET", base(room.id), teacher.headers)).json()) as JournalStaff;
    expect(journal).toMatchObject({ mode: "github", repository: { fullName, editable: false } });
    const page = (await call("GET", `${base(room.id)}/pages/README.md`, teacher.headers)).json<{ editUrl: string }>();
    expect(page.editUrl).toBe(`https://github.com/${fullName}/edit/main/README.md`);
  });

  it("still refuses an upload's own faults first", async () => {
    const { room } = await withJournal();
    const mismatch = await upload(room.id, "a.png", Buffer.from("x"), "image/jpeg");
    expect([mismatch.statusCode, mismatch.json().error]).toEqual([415, "type_mismatch"]);
    const big = await upload(room.id, "a.png", Buffer.alloc(JOURNAL_ASSET_MAX_BYTES + 1), "image/png");
    expect(big.statusCode).toBe(413); // Fastify's own
  });
});

describe("repository furniture is never written (N-SEC-15)", () => {
  it("refuses a workflow upload, a save and an add under .github, with no commit", async () => {
    const { room, fullName } = await withJournal();
    const commits = commitsTo(fullName).length;
    const workflow = await server.app.inject({
      method: "POST",
      url: `${base(room.id)}/assets/.github/workflows/x.yml`,
      headers: { ...teacher.headers, "content-type": "application/octet-stream" },
      payload: Buffer.from("on: push"),
    });
    expect(workflow.statusCode).toBe(404);
    const save = await call("PUT", `${base(room.id)}/pages/.github/x.md`, teacher.headers, { markdown: "x", baseSha: "a".repeat(40) });
    expect(save.statusCode).toBe(404);
    // The path of an add is its body: refused by the body's schema.
    const add = await call("POST", `${base(room.id)}/pages`, teacher.headers, { path: ".github/x.md" });
    expect(add.statusCode).toBe(400);
    expect(commitsTo(fullName).length).toBe(commits);
  });
});

// ---------------------------------------------------------------- who may write

describe("who may write", () => {
  let room: string;
  let impersonation: Headers;
  let seb: Headers;
  let kiosk: Headers;

  /** Every write, with a body it would accept. */
  const writes = (id: string) =>
    [
      ["POST", base(id), {}],
      ["POST", `${base(id)}/use`, { name: "x" }],
      ["DELETE", base(id), undefined],
      ["POST", `${base(id)}/refresh`, undefined],
      ["POST", `${base(id)}/preview`, { path: "a.md", markdown: "# a" }],
      ["PUT", `${base(id)}/pages/README.md`, { markdown: "# a", baseSha: "a".repeat(40) }],
      ["POST", `${base(id)}/pages`, { path: "b.md" }],
      ["DELETE", `${base(id)}/pages/README.md`, undefined],
      ["POST", `${base(id)}/assets/a.png`, { x: 1 }],
    ] as const;

  const sessionOf = async (userId: string, auth: Parameters<typeof createSession>[3]): Promise<Headers> => {
    const s = await createSession(server.app.db, userId, 8, auth);
    return { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
  };

  beforeAll(async () => {
    room = (await withJournal()).room.id;
    const seeded = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });
    const admin = await server.signIn("admin");
    impersonation = await sessionOf(student.id, { kind: "impersonation", actorUserId: admin.id, evaluationId: null });
    seb = await sessionOf(student.id, { kind: "seb", actorUserId: null, evaluationId: seeded.evaluationId });
    const station = await kioskStation(server.app);
    const k = await sessionOf(student.id, { kind: "kiosk", actorUserId: null, evaluationId: seeded.evaluationId, deviceId: station.deviceId });
    kiosk = { ...k, cookie: `${k.cookie}; ${station.cookie}` };
  });

  let commits: number;
  beforeEach(() => {
    commits = world.commits.length;
  });

  it.each([
    ["a student of the classroom", () => student.headers],
    ["a teacher off the course's staff", () => outsider.headers],
  ])("%s gets the 404 of a missing classroom, and writes nothing", async (_who, headers) => {
    for (const [method, url, body] of writes(room)) {
      const [real, missing] = await Promise.all([
        call(method, url, headers(), body),
        call(method, url.replace(room, randomUUID()), headers(), body),
      ]);
      expect([real.statusCode, real.body], `${method} ${url}`).toEqual([404, missing.body]);
    }
    expect(world.commits.length).toBe(commits);
    expect(await rowOf(room)).toBeDefined();
  });

  it("an impersonation session writes nothing (ADR-034)", async () => {
    for (const [method, url, body] of writes(room)) {
      const res = await call(method, url, impersonation, body);
      expect([res.statusCode, res.json().error], `${method} ${url}`).toEqual([403, "impersonation_read_only"]);
    }
    expect(world.commits.length).toBe(commits);
  });

  it.each([
    ["seb", () => seb],
    ["kiosk", () => kiosk],
  ])("a %s session is nobody (ADR-027)", async (_kind, headers) => {
    for (const [method, url, body] of writes(room)) {
      const [confined, anonymous] = await Promise.all([call(method, url, headers(), body), call(method, url, {}, body)]);
      expect(confined.statusCode, `${method} ${url}`).toBe(401);
      expect(confined.body).toBe(anonymous.body);
    }
    expect(await rowOf(room)).toBeDefined();
  });
});
