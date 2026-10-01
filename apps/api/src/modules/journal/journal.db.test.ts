/**
 * The journal's read routes, its webhooks and its J4 sweep (M4-02; ported
 * from heig-classroom's `modules/journal.db.test.ts` and extended), on a
 * server built with Quiz's App and a webhook secret, against the fake GitHub:
 *
 * - who reads what (F-JRN-12, invariant 6): the staff payload, the student
 *   payload for a claimed seat, a teacher asking `?view=student` and an
 *   impersonation session, the 404 of a missing classroom for the rest, and
 *   nobody for a `seb` or `kiosk` session (ADR-027);
 * - the one exit (invariant 4, N-SEC-12): a draft page, a future page and
 *   the assets only they reference are searched for in every student
 *   response, for each of the three student callers;
 * - the assets (N-SEC-13, J1): the headers, an SVG sandboxed, the ETag;
 * - a push fanned out to two classrooms, a repository renamed and deleted;
 * - the J4 sweep, which shows a page when its date passes without GitHub.
 */
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { encodeJournalPath, Journal, JournalPage, type JournalPageStaff } from "@quiz/contracts";

import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "../../auth/session.js";
import { loadConfig, type AppConfig } from "../../config.js";
import {
  classroomJournals,
  enrollments,
  githubClassroomLinks,
  githubOrganizations,
  journalPages,
  webhookDeliveries,
} from "../../db/schema.js";
import { subscribe, type BusMessage } from "../../events.js";
import { appKey, fakeGithub, orgsRoute, signedDelivery } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { kioskStation } from "../../test/kiosk.js";
import { seedLive } from "../../test/live.js";
import { ingestJournal, sweepVisibleFrom } from "./ingest.js";
import { blobSha, pushTo, repoRoute, type FakeFile, type FakeRepo } from "./testing.js";

const SECRET = "j".repeat(40);
const key = appKey();
const gh = fakeGithub();
const ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
  GITHUB_APP_SLUG: "quiz-test",
  GITHUB_WEBHOOK_SECRET: SECRET,
};
let server: TestServer;
let config: AppConfig;
const repos: FakeRepo[] = [];

type Headers = Record<string, string>;
type Signed = { id: string; headers: Headers };

let teacher: Signed;
let outsider: Signed;
let admin: Signed;
let student: Signed;
let unclaimed: Signed;
let impersonation: Headers;
let seb: Headers;
let kiosk: Headers;

// ---------------------------------------------------------------- the journal read

/**
 * README links everything; `010-open.md` is what students read; the draft
 * and the future page carry markers searched for in every student response,
 * and each references an asset nothing else does.
 */
const FILES: FakeFile[] = [
  {
    path: "README.md",
    content: "# Home\n\n[open](010-open.md) [draft](020-draft.md) [future](030-future.md)\n",
  },
  { path: "010-open.md", content: "# Open page\n\n![v](img/visible.png)\n![d](img/diagram.svg)\n" },
  {
    path: "020-draft.md",
    content: "---\ndraft: true\n---\n# SECRET-DRAFT-TITLE\n\nDRAFT-BODY-MARKER <b>raw</b>\n\n![x](img/draft-only.png)\n",
  },
  {
    path: "030-future.md",
    content: "---\nvisible_from: 2099-01-01\n---\n# SECRET-FUTURE-TITLE\n\nFUTURE-BODY-MARKER\n\n![y](img/future-only.png)\n",
  },
  { path: "img/visible.png", content: "VISIBLE-BYTES" },
  { path: "img/diagram.svg", content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' },
  { path: "img/draft-only.png", content: "DRAFT-BYTES" },
  { path: "img/future-only.png", content: "FUTURE-BYTES" },
];

/** What no student response may carry: paths, titles, bodies, shas, warnings. */
const SECRETS = [
  "020-draft",
  "030-future",
  "SECRET-DRAFT-TITLE",
  "SECRET-FUTURE-TITLE",
  "DRAFT-BODY-MARKER",
  "FUTURE-BODY-MARKER",
  "draft-only",
  "future-only",
  "raw_html",
  "markdown",
  "blobSha",
  "warnings",
  "hidden",
  // The repository (ADR-057): its organization, the edit links, the mode.
  "heig-prg",
  "github.com",
  "editUrl",
  "\"mode\"",
  ...FILES.map(blobSha),
];

let nextId = 5000;

/** A classroom of `teacherId`'s course, linked to an installed organization, with a journal on `repo`. */
async function journalClassroom(repo: FakeRepo, teacherId: string, studentIds: string[] = []) {
  const db = server.app.db;
  const seeded = await seedLive(db, { teacherId, studentIds, questions: 0 });
  const orgId = randomUUID();
  const installationId = nextId++;
  await db.insert(githubOrganizations).values({ id: orgId, login: `org-${installationId}`, githubOrgId: installationId, installationId });
  await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId, linkedBy: teacherId, linkedAt: new Date() });
  await db.insert(classroomJournals).values({
    classroomId: seeded.classroomId,
    mode: "github",
    githubRepoId: repo.id,
    fullName: `${repo.owner}/${repo.name}`,
    ref: "main",
    createdBy: teacherId,
  });
  return seeded;
}

function newRepo(files: FakeFile[]): FakeRepo {
  const id = nextId++;
  const repo: FakeRepo = { id, owner: "heig-prg", name: `journal-${id}`, branches: {} };
  pushTo(repo, files);
  repos.push(repo);
  return repo;
}

/** A session of `kind` for `userId`, as the cookies a browser would send. */
async function sessionOf(userId: string, auth: Parameters<typeof createSession>[3]): Promise<Headers> {
  const s = await createSession(server.app.db, userId, 8, auth);
  return { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
}

const get = (url: string, headers: Headers = {}) => server.app.inject({ method: "GET", url, headers });

let classroomId: string;
let evaluationId: string;
const base = (id = classroomId) => `/app/api/classrooms/${id}/journal`;

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  server = await testServer(ENV);
  config = loadConfig({ NODE_ENV: "test", ...ENV });
  gh.routes = [orgsRoute(() => []), repoRoute(() => repos)];
  [teacher, outsider, admin, student, unclaimed] = await Promise.all([
    server.signIn("teacher"),
    server.signIn("teacher"),
    server.signIn("admin"),
    server.signIn("student"),
    server.signIn("student", "unclaimed-journal@heig.test"),
  ]);
  const seeded = await journalClassroom(newRepo(FILES), teacher.id, [student.id]);
  classroomId = seeded.classroomId;
  evaluationId = seeded.evaluationId;
  // The roster names this address; nobody claimed the line.
  await server.app.db.insert(enrollments).values({
    id: randomUUID(),
    classroomId,
    nom: "Un",
    prenom: "Claimed",
    email: "unclaimed-journal@heig.test",
  });
  expect(await ingestJournal(server.app, config, classroomId)).toMatchObject({ status: "ok", pages: 4, assets: 4 });

  impersonation = await sessionOf(student.id, { kind: "impersonation", actorUserId: admin.id, evaluationId: null });
  seb = await sessionOf(student.id, { kind: "seb", actorUserId: null, evaluationId });
  const station = await kioskStation(server.app);
  const k = await sessionOf(student.id, { kind: "kiosk", actorUserId: null, evaluationId, deviceId: station.deviceId });
  kiosk = { ...k, cookie: `${k.cookie}; ${station.cookie}` };
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  key.remove();
});

describe("the staff read everything", () => {
  it("the navigation, what students do not see, the repository", async () => {
    const res = await get(base(), teacher.headers);
    expect(res.statusCode).toBe(200);
    const journal = Journal.parse(res.json());
    if (journal.view !== "staff") throw new Error("expected the staff payload");
    expect(journal.homePath).toBe("README.md");
    expect(journal.nav.map((n) => n.path)).toEqual(["010-open.md", "020-draft.md", "030-future.md"]);
    expect(journal.hiddenPaths).toEqual(["020-draft.md", "030-future.md"]);
    expect(journal.warningCount).toBe(1);
    expect(journal.proposedName).toBeNull();
    // GitHub mode is read-only in the platform (ADR-057).
    expect(journal.mode).toBe("github");
    expect(journal.repository).toMatchObject({ syncStatus: "ok", syncError: null, ref: "main", rootPath: "", editable: false });
  });

  it("a draft page with its source, its lock, its warnings and where to edit it", async () => {
    const res = await get(`${base()}/pages/020-draft.md`, teacher.headers);
    const page = JournalPage.parse(res.json());
    if (page.view !== "staff") throw new Error("expected the staff payload");
    expect(page).toMatchObject({ draft: true, hidden: true, title: "SECRET-DRAFT-TITLE", warnings: [{ code: "raw_html" }] });
    expect(page.markdown).toContain("DRAFT-BODY-MARKER");
    expect(page.blobSha).toBe(blobSha(FILES[2]!));
    expect(page.editUrl).toMatch(/^https:\/\/github\.com\/heig-prg\/journal-\d+\/edit\/main\/020-draft\.md$/);
  });

  it("the edit link of a page under a root folder, on a branch with a slash, its segments encoded", async () => {
    const repo = newRepo([]);
    pushTo(repo, [{ path: "notes/010 été #1.md", content: "# Été\n" }], "prof/s1");
    const { classroomId: id } = await journalClassroom(repo, teacher.id);
    await server.app.db
      .update(classroomJournals)
      .set({ ref: "prof/s1", rootPath: "notes" })
      .where(eq(classroomJournals.classroomId, id));
    await ingestJournal(server.app, config, id);
    const res = await get(`${base(id)}/pages/${encodeJournalPath("010 été #1.md")}`, teacher.headers);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<JournalPageStaff>().editUrl).toBe(
      `https://github.com/heig-prg/${repo.name}/edit/prof/s1/notes/010%20%C3%A9t%C3%A9%20%231.md`,
    );
  });

  it("an asset only a draft references", async () => {
    const res = await get(`${base()}/assets/img/draft-only.png`, teacher.headers);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("DRAFT-BYTES");
  });

  it("a classroom without a journal: none, and the name Create would propose", async () => {
    const other = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });
    expect((await get(base(other.classroomId), teacher.headers)).json()).toEqual({
      view: "staff",
      mode: null,
      repository: null,
      nav: [],
      homePath: null,
      hiddenPaths: [],
      warningCount: 0,
      proposedName: "a-journal",
    });
    // A student has no journal to read there: the 404 of a missing one.
    expect((await get(base(other.classroomId), student.headers)).statusCode).toBe(404);
    expect((await get(`${base(other.classroomId)}?view=student`, teacher.headers)).statusCode).toBe(404);
  });
});

describe("the student payload, the journal's one exit (invariant 4)", () => {
  const callers = () =>
    [
      ["a student with a claimed seat", student.headers, ""],
      ["a teacher asking for the student view", teacher.headers, "?view=student"],
      ["an impersonation session", impersonation, ""],
    ] as const;

  it.each([0, 1, 2])("serves the student payload, and nothing hidden, to caller %i", async (i) => {
    const [who, headers, query] = callers()[i]!;
    const bodies: string[] = [];

    const home = await get(`${base()}${query}`, headers);
    expect(home.statusCode, who).toBe(200);
    expect(Journal.parse(home.json())).toEqual({
      view: "student",
      nav: [{ path: "010-open.md", title: "Open page", pagePath: "010-open.md", children: [] }],
      homePath: "README.md",
    });
    bodies.push(home.body);

    for (const path of ["README.md", "010-open.md"]) {
      const res = await get(`${base()}/pages/${path}${query}`, headers);
      expect(res.statusCode, `${who} ${path}`).toBe(200);
      expect(JournalPage.parse(res.json()).view).toBe("student");
      bodies.push(res.body);
    }
    const readme = JSON.parse(bodies[1]!) as { html: string };
    expect(readme.html).toContain('href="./010-open.md"');

    // A hidden page, an asset only hidden pages reference: the 404 of a missing one.
    const missing = await get(`${base()}/pages/040-missing.md${query}`, headers);
    for (const url of [
      `${base()}/pages/020-draft.md${query}`,
      `${base()}/pages/030-future.md${query}`,
      `${base()}/assets/img/draft-only.png${query}`,
      `${base()}/assets/img/future-only.png${query}`,
      `${base()}/assets/img/missing.png${query}`,
    ]) {
      const res = await get(url, headers);
      expect([res.statusCode, res.body], `${who} ${url}`).toEqual([missing.statusCode, missing.body]);
      bodies.push(res.body);
    }
    expect(missing.statusCode).toBe(404);

    const asset = await get(`${base()}/assets/img/visible.png${query}`, headers);
    expect(asset.statusCode, who).toBe(200);
    expect(asset.body).toBe("VISIBLE-BYTES");

    for (const body of bodies) {
      for (const secret of SECRETS) expect(body, `${who}: ${secret}`).not.toContain(secret);
    }
  });

  it("gives an impersonation session exactly what the student reads", async () => {
    for (const path of ["", "/pages/README.md", "/pages/010-open.md"]) {
      const [theirs, ours] = await Promise.all([get(`${base()}${path}`, student.headers), get(`${base()}${path}`, impersonation)]);
      expect(ours.body).toBe(theirs.body);
    }
  });

  it("refuses a view that would widen", async () => {
    const res = await get(`${base()}?view=staff`, student.headers);
    expect(res.statusCode).toBe(400);
  });
});

describe("anyone else", () => {
  it.each([
    ["a teacher off the course's staff", () => outsider.headers],
    ["a student whose seat is not claimed", () => unclaimed.headers],
  ])("%s gets the 404 of a missing classroom", async (_who, headers) => {
    for (const path of ["", "/pages/README.md", "/assets/img/visible.png"]) {
      const [real, missing] = await Promise.all([
        get(`${base()}${path}`, headers()),
        get(`${base(randomUUID())}${path}`, headers()),
      ]);
      expect(real.statusCode, path).toBe(404);
      expect(real.body, path).toBe(missing.body);
    }
  });

  it.each([
    ["seb", () => seb],
    ["kiosk", () => kiosk],
  ])("a %s session is nobody on the journal (ADR-027)", async (_kind, headers) => {
    for (const path of ["", "/pages/README.md", "/assets/img/visible.png"]) {
      const [confined, anonymous] = await Promise.all([get(`${base()}${path}`, headers()), get(`${base()}${path}`)]);
      expect(confined.statusCode, path).toBe(401);
      expect(confined.body, path).toBe(anonymous.body);
    }
  });
});

describe("the assets (N-SEC-13)", () => {
  it("carry the blob sha as ETag, revalidate, and run nothing", async () => {
    const res = await get(`${base()}/assets/img/visible.png`, student.headers);
    expect(res.headers).toMatchObject({
      "content-type": "image/png",
      etag: `"${blobSha(FILES[4]!)}"`,
      "cache-control": "private, max-age=0, must-revalidate",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
    });
    const again = await get(`${base()}/assets/img/visible.png`, { ...student.headers, "if-none-match": res.headers.etag as string });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
  });

  it("answer a student who names a hidden asset's sha with the 404 of a missing one", async () => {
    const etag = `"${blobSha(FILES[6]!)}"`; // img/draft-only.png
    const res = await get(`${base()}/assets/img/draft-only.png`, { ...student.headers, "if-none-match": etag });
    expect(res.statusCode).toBe(404);
    expect(res.headers.etag).toBeUndefined();
  });

  it("sandbox an SVG, so that opened directly it runs nothing", async () => {
    const res = await get(`${base()}/assets/img/diagram.svg`, student.headers);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/svg+xml");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

// ---------------------------------------------------------------- the webhooks

const processed = (id: string) =>
  vi.waitFor(async () => {
    const [row] = await server.app.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, id));
    expect(row?.processedAt).not.toBeNull();
    return row!;
  });

/** Delivered, handled, and its error (null when it went through). */
async function deliver(event: string, payload: object): Promise<string | null> {
  const id = randomUUID();
  expect((await signedDelivery(server.app, SECRET, payload, { event, id })).statusCode).toBe(200);
  return (await processed(id)).error;
}

async function rowOf(id: string) {
  const [row] = await server.app.db.select().from(classroomJournals).where(eq(classroomJournals.classroomId, id));
  return row!;
}

describe("the webhooks", () => {
  let repo: FakeRepo;
  let first: string;
  let second: string;

  beforeAll(async () => {
    repo = newRepo([{ path: "README.md", content: "# One\n" }]);
    // Two classrooms of two courses on the same repository (D27): two copies.
    first = (await journalClassroom(repo, teacher.id)).classroomId;
    second = (await journalClassroom(repo, outsider.id)).classroomId;
  });

  const pushEvent = (after: string, ref = "refs/heads/main") => ({ ref, after, repository: { id: repo.id, full_name: `${repo.owner}/${repo.name}` } });

  it("a push fans out to every classroom holding the repository", async () => {
    const head = pushTo(repo, [{ path: "README.md", content: "# Two\n" }]);
    const seen: BusMessage[] = [];
    const off = subscribe((e) => seen.push(e));
    try {
      expect(await deliver("push", pushEvent(head))).toBeNull();
    } finally {
      off();
    }
    for (const id of [first, second]) {
      expect(await rowOf(id)).toMatchObject({ lastCommitSha: head, syncStatus: "ok" });
      const [page] = await server.app.db.select().from(journalPages).where(eq(journalPages.classroomId, id));
      expect(page!.title).toBe("Two");
      expect(seen).toContainEqual({ kind: "hint", type: "journal", topics: [`classroom:${id}`] });
    }
  });

  it("skips a head the copy already has, and another branch, without calling GitHub", async () => {
    const calls = gh.calls.length;
    expect(await deliver("push", pushEvent(repo.branches.main!.commit))).toBeNull();
    expect(await deliver("push", pushEvent("f".repeat(40), "refs/heads/other"))).toBeNull();
    expect(await deliver("push", pushEvent("f".repeat(40), "refs/tags/v1"))).toBeNull();
    expect(gh.calls.length).toBe(calls);
  });

  it("follows a renamed repository", async () => {
    repo.name = "journal-renamed";
    expect(await deliver("repository", { action: "renamed", repository: { id: repo.id, full_name: "heig-prg/journal-renamed" } })).toBeNull();
    for (const id of [first, second]) expect((await rowOf(id)).fullName).toBe("heig-prg/journal-renamed");
  });

  it("puts the journal in error when the repository is deleted, and keeps the pages readable", async () => {
    expect(await deliver("repository", { action: "deleted", repository: { id: repo.id, full_name: "heig-prg/journal-renamed" } })).toBeNull();
    for (const id of [first, second]) {
      expect(await rowOf(id)).toMatchObject({ syncStatus: "error", syncError: "repo_not_found" });
    }
    const res = await get(`${base(first)}/pages/README.md`, teacher.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe("Two");
  });
});

// ---------------------------------------------------------------- Quiz mode (ADR-057)

describe("a Quiz-mode journal", () => {
  it("is read by the staff with no repository, and never ingested nor refreshed from GitHub", async () => {
    const { classroomId: id } = await seedLive(server.app.db, { teacherId: teacher.id, questions: 0 });
    await server.app.db.insert(classroomJournals).values({ classroomId: id, mode: "quiz", createdBy: teacher.id, version: 7 });
    await server.app.db.insert(journalPages).values({
      id: randomUUID(),
      classroomId: id,
      path: "README.md",
      parentPath: "",
      sortKey: "README.md",
      title: "Home",
      blobSha: "a".repeat(40),
      markdown: "# Home\n",
      htmlStaff: "<h1>Home</h1>",
      htmlStudent: "<h1>Home</h1>",
    });
    const calls = gh.calls.length;

    expect(await ingestJournal(server.app, config, id)).toBeNull();
    const refreshed = await server.app.inject({ method: "POST", url: `${base(id)}/refresh`, headers: teacher.headers });
    expect(refreshed.statusCode).toBe(202);
    expect(gh.calls.length).toBe(calls);
    expect(await rowOf(id)).toMatchObject({ version: 7, syncStatus: "pending", lastSyncedAt: null });

    const journal = Journal.parse((await get(base(id), teacher.headers)).json());
    expect(journal).toMatchObject({ view: "staff", mode: "quiz", repository: null, homePath: "README.md" });
    const page = (await get(`${base(id)}/pages/README.md`, teacher.headers)).json<JournalPageStaff>();
    expect(page).toMatchObject({ title: "Home", editUrl: null });
  });
});

// ---------------------------------------------------------------- J4

describe("the visible_from sweep (J4)", () => {
  it("shows a page to students when its date passes, without calling GitHub", async () => {
    const repo = newRepo([
      { path: "README.md", content: "# Home\n\n[later](010-later.md)\n" },
      { path: "010-later.md", content: "---\nvisible_from: 2099-01-01\n---\n# Later\n\n![l](l.png)\n" },
      { path: "l.png", content: "LATER-BYTES" },
    ]);
    const { classroomId: id } = await journalClassroom(repo, teacher.id, [student.id]);
    await ingestJournal(server.app, config, id);
    const readme = async () => (await get(`${base(id)}/pages/README.md`, student.headers)).json().html as string;
    expect(await readme()).not.toContain("010-later");
    expect((await get(`${base(id)}/pages/010-later.md`, student.headers)).statusCode).toBe(404);
    expect(await sweepVisibleFrom(server.app)).not.toContain(id);

    // An hour passes: rendered then, the page's date came a minute ago.
    await server.app.db
      .update(journalPages)
      .set({ visibleFrom: sql`now() - interval '1 minute'` })
      .where(eq(journalPages.classroomId, id));
    await server.app.db
      .update(classroomJournals)
      .set({ studentRenderedAt: sql`now() - interval '1 hour'` })
      .where(eq(classroomJournals.classroomId, id));
    // Visible by the database's clock at once; linked once the sweep ran.
    expect((await get(`${base(id)}/pages/010-later.md`, student.headers)).statusCode).toBe(200);

    const calls = gh.calls.length;
    const seen: BusMessage[] = [];
    const off = subscribe((e) => seen.push(e));
    try {
      expect(await sweepVisibleFrom(server.app)).toEqual([id]);
    } finally {
      off();
    }
    expect(gh.calls.length).toBe(calls);
    expect(seen).toContainEqual({ kind: "hint", type: "journal", topics: [`classroom:${id}`] });
    expect(await readme()).toContain('href="./010-later.md"');
    expect((await get(`${base(id)}/assets/l.png`, student.headers)).body).toBe("LATER-BYTES");
    // Done once: the next minute finds nothing to do.
    expect(await sweepVisibleFrom(server.app)).toEqual([]);
  });
});
