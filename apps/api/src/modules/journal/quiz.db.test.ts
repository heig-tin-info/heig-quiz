/**
 * The Quiz-mode journal (ADR-057, M4-08), on a server built with NO GitHub
 * configuration at all — no App, no organization:
 *
 * - created with nothing but its mode, with its home page and a revision;
 * - save against the page's version (a stale one is 409 `conflict` and
 *   writes nothing), add, delete, upload, each re-rendering the journal: a
 *   page becoming a draft or published changes its neighbours' student
 *   HTML, an upload resolves a page's image;
 * - the assets: sha256 ETag, append-only, J1 (an asset of a draft only is a
 *   404 to a student), collected once nothing references them;
 * - revisions listed and restored, a deleted page's too, audited;
 * - remove: the only copy, with the classroom's name typed;
 * - the student exit (invariant 4): no revision's content, no draft, no
 *   deleted page in any student response, for the three student callers;
 *   no student reaches the revisions; an impersonation session writes
 *   nothing.
 */
import { createHash, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  Journal,
  JournalDeletedPage,
  JournalFileWritten,
  JournalRefusal,
  JournalRevisionContent,
  JournalRevisionList,
  type JournalPageStaff,
  type JournalStaff,
} from "@quiz/contracts";

import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "../../auth/session.js";
import { auditLog, classroomJournals, journalAssets, journalPageRevisions, journalPages } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";

let server: TestServer;
type Headers = Record<string, string>;
let teacher: { id: string; headers: Headers };
let student: { id: string; headers: Headers };
let impersonation: Headers;

const base = (id: string) => `/app/api/classrooms/${id}/journal`;
const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, headers: Headers, payload?: unknown) =>
  server.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const upload = (id: string, path: string, body: Buffer, type = "image/png") =>
  server.app.inject({ method: "POST", url: `${base(id)}/assets/${path}`, headers: { ...teacher.headers, "content-type": type }, payload: body });

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const auditOf = (id: string, action: string) =>
  server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.subjectId, id), eq(auditLog.action, action)));

const revisionsOf = (id: string, path: string) =>
  server.app.db
    .select()
    .from(journalPageRevisions)
    .where(and(eq(journalPageRevisions.classroomId, id), eq(journalPageRevisions.path, path)));

const pageRow = async (id: string, path: string) =>
  (await server.app.db.select().from(journalPages).where(and(eq(journalPages.classroomId, id), eq(journalPages.path, path))))[0];

async function staffPage(id: string, path: string): Promise<JournalPageStaff> {
  const res = await call("GET", `${base(id)}/pages/${path}`, teacher.headers);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<JournalPageStaff>();
}

/** Saves `markdown` over the page as the staff now read it. */
async function save(id: string, path: string, markdown: string) {
  const { version } = await staffPage(id, path);
  const res = await call("PUT", `${base(id)}/pages/${path}`, teacher.headers, { markdown, baseVersion: version });
  expect(res.statusCode, res.body).toBe(200);
  return JournalFileWritten.parse(res.json());
}

async function add(id: string, path: string, title?: string) {
  const res = await call("POST", `${base(id)}/pages`, teacher.headers, title ? { path, title } : { path });
  expect(res.statusCode, res.body).toBe(201);
  return JournalFileWritten.parse(res.json());
}

/** A classroom of the teacher's course, the student seated, with a Quiz-mode journal. */
async function quizJournal() {
  const { classroomId } = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });
  const res = await call("POST", base(classroomId), teacher.headers, { mode: "quiz" });
  expect(res.statusCode, res.body).toBe(201);
  return { id: classroomId, journal: Journal.parse(res.json()) as JournalStaff };
}

beforeAll(async () => {
  // No GITHUB_* at all: a platform without Quiz's App.
  server = await testServer();
  [teacher, student] = await Promise.all([server.signIn("teacher"), server.signIn("student")]);
  const admin = await server.signIn("admin");
  const s = await createSession(server.app.db, student.id, 8, { kind: "impersonation", actorUserId: admin.id, evaluationId: null });
  impersonation = { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
});

afterAll(async () => {
  await server.close();
});

describe("create a Quiz-mode journal, with no GitHub at all", () => {
  it("needs nothing but its mode, and starts with its home page and its revision", async () => {
    const { id, journal } = await quizJournal();
    expect(journal).toMatchObject({ view: "staff", mode: "quiz", repository: null, homePath: "README.md", pageCount: 1, proposedName: null });
    const home = await staffPage(id, "README.md");
    expect(home).toMatchObject({ title: "A", markdown: "# A\n", editUrl: null, hidden: false });
    expect((await revisionsOf(id, "README.md")).map((r) => r.markdown)).toEqual(["# A\n"]);
    expect((await auditOf(id, "journal.create"))[0]!.payload).toEqual({ mode: "quiz" });
    // A student reads it at once.
    expect((await call("GET", `${base(id)}/pages/README.md`, student.headers)).statusCode).toBe(200);

    const twice = await call("POST", base(id), teacher.headers, { mode: "quiz" });
    expect([twice.statusCode, JournalRefusal.parse(twice.json()).error]).toEqual([409, "journal_exists"]);
  });

  it("refuses a GitHub-mode one without Quiz's App, and has none of its routes", async () => {
    const { classroomId } = await seedLive(server.app.db, { teacherId: teacher.id, questions: 0 });
    const res = await call("POST", base(classroomId), teacher.headers, { mode: "github" });
    expect([res.statusCode, res.json().error]).toEqual([409, "not_connected"]);
    expect((await call("POST", `${base(classroomId)}/use`, teacher.headers, { name: "x" })).statusCode).toBe(404);
    expect((await call("POST", `${base(classroomId)}/refresh`, teacher.headers)).statusCode).toBe(404);
    expect((await call("POST", base(classroomId), teacher.headers, {})).statusCode).toBe(400);
  });
});

describe("the pages", () => {
  it("a save against the version opened; a stale one is 409 and writes nothing", async () => {
    const { id } = await quizJournal();
    const opened = await staffPage(id, "README.md");
    const first = await call("PUT", `${base(id)}/pages/README.md`, teacher.headers, { markdown: "# One\n", baseVersion: opened.version });
    expect(first.statusCode, first.body).toBe(200);
    const written = JournalFileWritten.parse(first.json());
    expect(written.page).toMatchObject({ title: "One", version: opened.version + 1 });

    // A second tab still holds the version it opened.
    const stale = await call("PUT", `${base(id)}/pages/README.md`, teacher.headers, { markdown: "# Two\n", baseVersion: opened.version });
    expect([stale.statusCode, JournalRefusal.parse(stale.json()).error]).toEqual([409, "conflict"]);
    expect((await pageRow(id, "README.md"))!.markdown).toBe("# One\n");
    expect((await revisionsOf(id, "README.md")).map((r) => r.markdown).sort()).toEqual(["# A\n", "# One\n"]);
    expect(await auditOf(id, "journal.save")).toHaveLength(1);
    expect((await auditOf(id, "journal.save"))[0]!.payload).toMatchObject({ mode: "quiz", path: "README.md", version: opened.version + 1 });

    // A page that is not there is no version to save against.
    const missing = await call("PUT", `${base(id)}/pages/nope.md`, teacher.headers, { markdown: "# x\n", baseVersion: 0 });
    expect([missing.statusCode, missing.json().error]).toEqual([409, "conflict"]);
  });

  it("add, add again, delete, delete again", async () => {
    const { id } = await quizJournal();
    const added = await add(id, "010-basics/README.md", "Basics");
    expect(added.page).toMatchObject({ path: "010-basics/README.md", title: "Basics", markdown: "# Basics\n" });
    const again = await call("POST", `${base(id)}/pages`, teacher.headers, { path: "010-basics/README.md" });
    expect([again.statusCode, again.json().error]).toEqual([409, "page_exists"]);
    const journal = Journal.parse((await call("GET", base(id), teacher.headers)).json()) as JournalStaff;
    expect(journal.nav).toEqual([{ path: "010-basics", title: "Basics", pagePath: "010-basics/README.md", children: [] }]);
    expect(journal.pageCount).toBe(2);

    expect((await call("DELETE", `${base(id)}/pages/010-basics/README.md`, teacher.headers)).statusCode).toBe(204);
    expect((await call("DELETE", `${base(id)}/pages/010-basics/README.md`, teacher.headers)).statusCode).toBe(404);
    expect(await pageRow(id, "010-basics/README.md")).toBeUndefined();
    // Its revisions stay.
    expect(await revisionsOf(id, "010-basics/README.md")).toHaveLength(1);
    expect((await auditOf(id, "journal.add"))[0]!.payload).toEqual({ mode: "quiz", path: "010-basics/README.md" });
    expect(await auditOf(id, "journal.delete")).toHaveLength(1);
  });

  it("renders the other pages again: a link to a draft is never in the student HTML", async () => {
    const { id } = await quizJournal();
    await save(id, "README.md", "# Home\n\n[next](010-next.md)\n");
    // No such page yet: a warning, and text for everyone.
    expect((await pageRow(id, "README.md"))!.warnings).toEqual([{ code: "target_missing", href: "010-next.md", path: "010-next.md" }]);

    await add(id, "010-next.md", "Next");
    await save(id, "010-next.md", "---\ndraft: true\n---\n# Next\n");
    let home = (await pageRow(id, "README.md"))!;
    expect(home.warnings).toEqual([]);
    expect(home.htmlStaff).toContain('href="./010-next.md"');
    expect(home.htmlStudent).not.toContain("010-next");
    expect((await call("GET", `${base(id)}/pages/010-next.md`, student.headers)).statusCode).toBe(404);

    await save(id, "010-next.md", "# Next\n");
    home = (await pageRow(id, "README.md"))!;
    expect(home.htmlStudent).toContain('href="./010-next.md"');
    const read = await call("GET", `${base(id)}/pages/README.md`, student.headers);
    expect(read.json().html).toContain('href="./010-next.md"');

    // Deleted: unlinked again, for everyone.
    await call("DELETE", `${base(id)}/pages/010-next.md`, teacher.headers);
    home = (await pageRow(id, "README.md"))!;
    expect(home.htmlStaff).not.toContain("href=\"./010-next.md\"");
    expect(home.warnings).toHaveLength(1);
  });

  it("a page whose visible_from passes is linked by the J4 sweep, as an ingested one", async () => {
    const { id } = await quizJournal();
    await save(id, "README.md", "# Home\n\n[later](later.md)\n");
    await add(id, "later.md");
    await save(id, "later.md", "---\nvisible_from: 2099-01-01\n---\n# Later\n");
    expect((await pageRow(id, "README.md"))!.htmlStudent).not.toContain("later.md");
    await server.app.db.update(journalPages).set({ visibleFrom: sql`now() - interval '1 minute'` }).where(eq(journalPages.classroomId, id));
    await server.app.db.update(classroomJournals).set({ studentRenderedAt: sql`now() - interval '1 hour'` }).where(eq(classroomJournals.classroomId, id));
    const { sweepVisibleFrom } = await import("./ingest.js");
    expect(await sweepVisibleFrom(server.app)).toContain(id);
    expect((await pageRow(id, "README.md"))!.htmlStudent).toContain('href="./later.md"');
  });
});

describe("the assets", () => {
  it("resolve a page's image once uploaded; append-only; the sha256 as ETag", async () => {
    const { id } = await quizJournal();
    await add(id, "010-week/README.md", "Week");
    await save(id, "010-week/README.md", "# Week\n\n![fig](images/fig.png)\n");
    expect((await pageRow(id, "010-week/README.md"))!.warnings).toMatchObject([{ code: "target_missing" }]);

    const bytes = Buffer.from("PNG-FIG");
    const res = await upload(id, "010-week/images/fig.png", bytes);
    expect(res.statusCode, res.body).toBe(201);
    expect(JournalFileWritten.parse(res.json())).toEqual({ path: "010-week/images/fig.png", page: null });
    const page = (await pageRow(id, "010-week/README.md"))!;
    expect(page.warnings).toEqual([]);
    expect(page.assetPaths).toEqual(["010-week/images/fig.png"]);
    expect(page.htmlStudent).toContain(`${base(id)}/assets/010-week/images/fig.png`);

    const served = await call("GET", `${base(id)}/assets/010-week/images/fig.png`, student.headers);
    expect([served.statusCode, served.body, served.headers.etag]).toEqual([200, "PNG-FIG", `"${sha256(bytes)}"`]);

    // The same bytes again: nothing changes. Others: refused.
    expect((await upload(id, "010-week/images/fig.png", bytes)).statusCode).toBe(201);
    const other = await upload(id, "010-week/images/fig.png", Buffer.from("OTHER"));
    expect([other.statusCode, other.json().error]).toEqual([409, "asset_exists"]);
    const audited = await auditOf(id, "journal.upload");
    expect(audited.map((a) => a.payload)).toEqual([{ mode: "quiz", path: "010-week/images/fig.png", bytes: 7, blobSha: sha256(bytes) }]);
  });

  it("an asset only a draft references is a 404 to a student, served once the page is published (J1)", async () => {
    const { id } = await quizJournal();
    await add(id, "secret.md");
    expect((await upload(id, "images/secret.png", Buffer.from("SECRET-BYTES"))).statusCode).toBe(201);
    await save(id, "secret.md", "---\ndraft: true\n---\n# S\n\n![s](images/secret.png)\n");
    const url = `${base(id)}/assets/images/secret.png`;
    expect((await call("GET", url, student.headers)).statusCode).toBe(404);
    expect((await call("GET", url, teacher.headers)).body).toBe("SECRET-BYTES");
    await save(id, "secret.md", "# S\n\n![s](images/secret.png)\n");
    expect((await call("GET", url, student.headers)).body).toBe("SECRET-BYTES");
  });

  it("are kept until the journal goes: a restored revision finds its image again", async () => {
    const { id } = await quizJournal();
    await add(id, "fig.md");
    await save(id, "fig.md", "# Fig\n\n![f](images/fig.png)\n");
    expect((await upload(id, "images/fig.png", Buffer.from("FIG-BYTES"))).statusCode).toBe(201);
    const [withImage] = JournalRevisionList.parse((await call("GET", `${base(id)}/revisions/fig.md`, teacher.headers)).json());
    expect((await call("DELETE", `${base(id)}/pages/fig.md`, teacher.headers)).statusCode).toBe(204);
    await save(id, "README.md", "# Something else\n");

    const restored = await call("POST", `${base(id)}/restore`, teacher.headers, { revisionId: withImage!.id });
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await pageRow(id, "fig.md"))!.assetPaths).toEqual(["images/fig.png"]);
    expect((await call("GET", `${base(id)}/assets/images/fig.png`, teacher.headers)).body).toBe("FIG-BYTES");
  });

  it("an identical upload again renders nothing and bumps nothing", async () => {
    const { id } = await quizJournal();
    expect((await upload(id, "a.png", Buffer.from("A"))).statusCode).toBe(201);
    const [before] = await server.app.db.select().from(classroomJournals).where(eq(classroomJournals.classroomId, id));
    expect((await upload(id, "a.png", Buffer.from("A"))).statusCode).toBe(201);
    const [after] = await server.app.db.select().from(classroomJournals).where(eq(classroomJournals.classroomId, id));
    expect(after!.version).toBe(before!.version);
    expect(await auditOf(id, "journal.upload")).toHaveLength(1);
  });
});

describe("the revisions", () => {
  it("list a page's saves newest first, and restore one as a new save", async () => {
    const { id } = await quizJournal();
    await save(id, "README.md", "# Second\n");
    await save(id, "README.md", "# Third\n");
    const res = await call("GET", `${base(id)}/revisions/README.md`, teacher.headers);
    const list = JournalRevisionList.parse(res.json());
    const markdownOf = async (rid: string) =>
      JournalRevisionContent.parse((await call("GET", `${base(id)}/revision/${rid}`, teacher.headers)).json()).markdown;
    expect(await Promise.all(list.map((r) => markdownOf(r.id)))).toEqual(["# Third\n", "# Second\n", "# A\n"]);
    expect(list[0]).toEqual({ id: list[0]!.id, path: "README.md", author: "Test teacher", createdAt: list[0]!.createdAt });
    expect((await call("GET", `${base(id)}/revision/${randomUUID()}`, teacher.headers)).statusCode).toBe(404);

    const before = await staffPage(id, "README.md");
    const restored = await call("POST", `${base(id)}/restore`, teacher.headers, { revisionId: list[2]!.id });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(JournalFileWritten.parse(restored.json()).page).toMatchObject({ markdown: "# A\n", title: "A", version: before.version + 1 });
    const after = JournalRevisionList.parse((await call("GET", `${base(id)}/revisions/README.md`, teacher.headers)).json());
    expect(await Promise.all(after.map((r) => markdownOf(r.id)))).toEqual(["# A\n", "# Third\n", "# Second\n", "# A\n"]);
    expect((await auditOf(id, "journal.restore"))[0]!.payload).toEqual({ mode: "quiz", path: "README.md", revisionId: list[2]!.id });

    const unknown = await call("POST", `${base(id)}/restore`, teacher.headers, { revisionId: randomUUID() });
    expect(unknown.statusCode).toBe(404);
  });

  it("outlive a deleted page, which a restore creates again", async () => {
    const { id } = await quizJournal();
    await add(id, "gone.md", "Gone");
    await save(id, "gone.md", "# Gone for good\n");
    await call("DELETE", `${base(id)}/pages/gone.md`, teacher.headers);
    const deleted = (await call("GET", `${base(id)}/deleted`, teacher.headers)).json<unknown[]>().map((d) => JournalDeletedPage.parse(d));
    const [latest] = JournalRevisionList.parse((await call("GET", `${base(id)}/revisions/gone.md`, teacher.headers)).json());
    expect(deleted).toMatchObject([{ path: "gone.md", title: "Gone for good", revisionId: latest!.id }]);

    const res = await call("POST", `${base(id)}/restore`, teacher.headers, { revisionId: deleted[0]!.revisionId });
    expect(res.statusCode, res.body).toBe(200);
    expect((await pageRow(id, "gone.md"))!.markdown).toBe("# Gone for good\n");
    expect((await call("GET", `${base(id)}/deleted`, teacher.headers)).json()).toEqual([]);
    expect(await revisionsOf(id, "gone.md")).toHaveLength(3);
  });

  it("are the staff's alone", async () => {
    const { id } = await quizJournal();
    const outsider = await server.signIn("teacher");
    const [rev] = await revisionsOf(id, "README.md");
    for (const url of [`${base(id)}/revisions/README.md`, `${base(id)}/revision/${rev!.id}`, `${base(id)}/deleted`]) {
      for (const headers of [student.headers, impersonation, outsider.headers]) {
        const [real, missing] = await Promise.all([call("GET", url, headers), call("GET", url.replace(id, randomUUID()), headers)]);
        expect([real.statusCode, real.body], url).toEqual([404, missing.body]);
      }
    }
  });
});

describe("GitHub mode stays read-only", () => {
  it("refuses a Quiz-mode write to a GitHub-mode row with 409 read_only", async () => {
    const { classroomId: id } = await seedLive(server.app.db, { teacherId: teacher.id, questions: 0 });
    await server.app.db
      .insert(classroomJournals)
      .values({ classroomId: id, mode: "github", githubRepoId: 1, fullName: "o/r", ref: "main", createdBy: teacher.id });
    for (const res of [
      await call("POST", `${base(id)}/pages`, teacher.headers, { path: "a.md" }),
      await upload(id, "a.png", Buffer.from("x")),
    ]) {
      expect([res.statusCode, res.json().error]).toEqual([409, "read_only"]);
    }
  });
});

describe("remove (F-JRN-04): the only copy", () => {
  it("needs the classroom's name typed, then deletes pages, assets and revisions", async () => {
    const { id } = await quizJournal();
    await upload(id, "x.png", Buffer.from("x"));
    for (const url of [base(id), `${base(id)}?confirm=B`]) {
      const res = await call("DELETE", url, teacher.headers);
      expect([res.statusCode, res.json().error], url).toEqual([409, "confirm_required"]);
    }
    expect((await call("GET", base(id), teacher.headers)).json().pageCount).toBe(1);

    expect((await call("DELETE", `${base(id)}?confirm=A`, teacher.headers)).statusCode).toBe(204);
    for (const table of [journalPages, journalAssets, journalPageRevisions]) {
      expect(await server.app.db.select().from(table).where(eq(table.classroomId, id))).toEqual([]);
    }
    expect((await auditOf(id, "journal.remove"))[0]!.payload).toMatchObject({ mode: "quiz", pages: 1 });
  });
});

describe("deleting the classroom (F-ORG-09) takes the same confirmation", () => {
  const remove = (id: string, query = "") => call("DELETE", `/app/api/classrooms/${id}${query}`, teacher.headers);

  it("refuses without the name when a Quiz journal has pages, and deletes with it", async () => {
    const { id } = await quizJournal();
    for (const query of ["", "?confirm=B"]) {
      const res = await remove(id, query);
      expect([res.statusCode, JournalRefusal.parse(res.json()).error], query).toEqual([409, "confirm_required"]);
    }
    expect(await pageRow(id, "README.md")).toBeDefined();
    expect((await remove(id, "?confirm=A")).statusCode).toBe(204);
    expect(await server.app.db.select().from(journalPageRevisions).where(eq(journalPageRevisions.classroomId, id))).toEqual([]);
  });

  it("needs nothing for an empty Quiz journal, a GitHub-mode one, or none", async () => {
    const empty = await quizJournal();
    expect((await call("DELETE", `${base(empty.id)}/pages/README.md`, teacher.headers)).statusCode).toBe(204);
    expect((await remove(empty.id)).statusCode).toBe(204);

    const { classroomId: github } = await seedLive(server.app.db, { teacherId: teacher.id, questions: 0 });
    await server.app.db
      .insert(classroomJournals)
      .values({ classroomId: github, mode: "github", githubRepoId: 2, fullName: "o/r2", ref: "main", createdBy: teacher.id });
    await server.app.db.insert(journalPages).values({
      id: randomUUID(),
      classroomId: github,
      path: "README.md",
      parentPath: "",
      sortKey: "0:readme.md",
      blobSha: "a".repeat(40),
      markdown: "# R\n",
      htmlStaff: "",
      htmlStudent: "",
    });
    expect((await remove(github)).statusCode).toBe(204);

    const { classroomId: bare } = await seedLive(server.app.db, { teacherId: teacher.id, questions: 0 });
    expect((await remove(bare)).statusCode).toBe(204);
    expect((await remove(bare)).statusCode).toBe(404);
  });

  it("refuses an unknown query parameter", async () => {
    const { id } = await quizJournal();
    expect((await remove(id, "?force=1")).statusCode).toBe(400);
  });
});

describe("the student exit (invariant 4)", () => {
  it("never carries a former revision, a draft or a deleted page, to any student caller", async () => {
    const { id } = await quizJournal();
    await save(id, "README.md", "# Home\n\nOLD-REVISION-MARKER\n");
    await save(id, "README.md", "# Home\n\n[d](draft.md) [g](gone.md)\n\n![p](public.png)\n");
    await add(id, "draft.md");
    await save(id, "draft.md", "---\ndraft: true\n---\n# DRAFT-TITLE-MARKER\n\nDRAFT-BODY-MARKER\n\n![x](draft-only.png)\n");
    await add(id, "gone.md");
    await save(id, "gone.md", "# DELETED-PAGE-MARKER\n");
    await call("DELETE", `${base(id)}/pages/gone.md`, teacher.headers);
    await add(id, "future.md");
    await save(id, "future.md", "---\nvisible_from: 2099-01-01\n---\n# FUTURE-TITLE-MARKER\n\nFUTURE-BODY-MARKER\n\n![f](future-only.png)\n");
    await save(id, "README.md", "# Home\n\n[d](draft.md) [g](gone.md) [f](future.md)\n\n![p](public.png)\n");
    await upload(id, "public.png", Buffer.from("PUBLIC"));
    await upload(id, "draft-only.png", Buffer.from("DRAFT-ONLY-BYTES"));
    await upload(id, "future-only.png", Buffer.from("FUTURE-ONLY-BYTES"));
    // The staff link the hidden pages; students never.
    expect((await pageRow(id, "README.md"))!.htmlStaff).toContain('href="./future.md"');

    const secrets = [
      "OLD-REVISION-MARKER",
      "DRAFT-TITLE-MARKER",
      "DRAFT-BODY-MARKER",
      "DELETED-PAGE-MARKER",
      "DRAFT-ONLY-BYTES",
      "FUTURE-TITLE-MARKER",
      "FUTURE-BODY-MARKER",
      "FUTURE-ONLY-BYTES",
      "future.md",
      "future-only",
      "draft.md",
      "gone.md",
      "draft-only",
      "markdown",
      "version",
      "revision",
      "pageCount",
    ];
    const callers: [string, Headers, string][] = [
      ["a student", student.headers, ""],
      ["a teacher in the student view", teacher.headers, "?view=student"],
      ["an impersonation session", impersonation, ""],
    ];
    for (const [who, headers, query] of callers) {
      const bodies: string[] = [];
      for (const url of [
        `${base(id)}${query}`,
        `${base(id)}/pages/README.md${query}`,
        `${base(id)}/pages/draft.md${query}`,
        `${base(id)}/pages/gone.md${query}`,
        `${base(id)}/assets/draft-only.png${query}`,
        `${base(id)}/pages/future.md${query}`,
        `${base(id)}/assets/future-only.png${query}`,
      ]) {
        bodies.push((await call("GET", url, headers)).body);
      }
      const asset = await call("GET", `${base(id)}/assets/public.png${query}`, headers);
      expect(asset.body, who).toBe("PUBLIC");
      for (const body of bodies) {
        for (const secret of secrets) expect(body, `${who}: ${secret}`).not.toContain(secret);
      }
    }
  });

  it("an impersonation session writes nothing", async () => {
    const { id } = await quizJournal();
    const { version } = await staffPage(id, "README.md");
    for (const [method, url, body] of [
      ["PUT", `${base(id)}/pages/README.md`, { markdown: "# x", baseVersion: version }],
      ["POST", `${base(id)}/pages`, { path: "b.md" }],
      ["POST", `${base(id)}/restore`, { revisionId: randomUUID() }],
    ] as const) {
      const res = await call(method, url, impersonation, body);
      expect([res.statusCode, res.json().error], url).toEqual([403, "impersonation_read_only"]);
    }
    expect((await pageRow(id, "README.md"))!.version).toBe(version);
  });
});
