/**
 * The course library (F-ORG-18, F-ADMIN-10, ADR-144), over the real
 * application: the kind decided by the bytes, the caps, the content-addressed
 * store shared by two courses without either learning of the other, the
 * quota under a lock, the rename, who may delete, the sweep and its grace,
 * the ranged file response and its inert headers, who reaches what
 * (invariant 6) and the administrator's quota.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CourseDocument, CourseLibrary, DEFAULT_DOCUMENTS_QUOTA_BYTES, DocumentHtml } from "@quiz/contracts";
import { RENDERER_VERSION, renderStandalone } from "@quiz/docrender";

import { auditLog, courseDocuments, courseStaff, courses } from "../../db/schema.js";
import { testServer, type Actor, type TestServer } from "../../test/http.js";
import type { AppConfig } from "../../config.js";
import { LIBRARY_TASKS } from "./jobs.js";
import { documentPath, removeIfUnnamed, rerenderDocuments, sweepCandidates, sweepDocumentFiles, SWEEP_GRACE_MS } from "./service.js";

const MAX = 8192;

let server: TestServer;
let owner: Actor;
let assistant: Actor;
let colleague: Actor;
let stranger: Actor;
let admin: Actor;

beforeAll(async () => {
  server = await testServer({ DOCUMENT_MAX_BYTES: String(MAX) });
  owner = await server.signIn("teacher");
  assistant = await server.signIn("teacher");
  colleague = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  admin = await server.signIn("admin");
});
afterAll(async () => {
  await server.close();
});

const db = () => server.app.db;

/** A course whose owner is `owner`, with `assistant` and `colleague` as assistants. */
async function course(quotaBytes?: number): Promise<string> {
  const id = randomUUID();
  await db().insert(courses).values({ id, name: "Electronics", code: "ELN", ...(quotaBytes === undefined ? {} : { documentsQuotaBytes: quotaBytes }) });
  await db().insert(courseStaff).values([
    { courseId: id, userId: owner.id, role: "owner" },
    { courseId: id, userId: assistant.id, role: "assistant" },
    { courseId: id, userId: colleague.id, role: "assistant" },
  ]);
  return id;
}

/** A distinct small PDF, `size` bytes long. */
const pdf = (marker = randomUUID(), size = 64) => {
  const head = Buffer.from(`%PDF-1.7\n%${marker}\n`, "latin1");
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x20)]);
};

/** A multipart body of one file, as a browser's `FormData` sends it. */
function multipart(bytes: Buffer, filename: string, mime: string) {
  const boundary = `----library${randomUUID()}`;
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

const base = (courseId: string) => `/app/api/courses/${courseId}/documents`;

const upload = (courseId: string, bytes: Buffer, filename = "sheet.pdf", who: Actor = owner, mime = "application/octet-stream") => {
  const form = multipart(bytes, filename, mime);
  return server.app.inject({
    method: "POST",
    url: base(courseId),
    headers: { ...who.headers, ...form.headers },
    payload: form.payload,
  });
};

const get = (url: string, who: Actor = owner, headers: Record<string, string> = {}) =>
  server.app.inject({ method: "GET", url, headers: { ...who.headers, ...headers } });

const library = async (courseId: string, who: Actor = owner) => {
  const res = await get(base(courseId), who);
  expect(res.statusCode, res.body).toBe(200);
  return CourseLibrary.parse(res.json());
};

const fileOf = (sha256: string) => join(server.assetsDir, documentPath(sha256));

describe("an upload (F-ORG-18, N-SEC-24)", () => {
  it("takes a PDF by its bytes, whatever the browser declared, and stores it by its hash", async () => {
    const id = await course();
    const bytes = pdf();
    const res = await upload(id, bytes, "Datasheet LM358.pdf", owner, "text/plain");
    expect(res.statusCode, res.body).toBe(201);
    const document = CourseDocument.parse(res.json());
    expect(document).toMatchObject({
      title: "Datasheet LM358",
      filename: "Datasheet LM358.pdf",
      kind: "pdf",
      bytes: bytes.length,
      warnings: [],
      missing: false,
      canDelete: true,
      uploadedBy: { id: owner.id, name: "Test teacher" },
    });
    const [row] = await db().select().from(courseDocuments).where(eq(courseDocuments.id, document.id));
    expect(row).toMatchObject({ html: null, renderedWith: null });
    expect(await readFile(fileOf(row!.sha256))).toEqual(bytes);
    // The upload left no temporary file behind.
    expect(await readdir(join(server.assetsDir, "documents/tmp"))).toEqual([]);
  });

  it("renders a Markdown file at upload and keeps what the rendering reported", async () => {
    const id = await course();
    const source = "# Formulaire\n\n<b>gras</b>\n\n![schéma](img/s.png)\n\n$$U = RI$$\n";
    const res = await upload(id, Buffer.from(source), "formulaire.md", assistant, "application/pdf");
    expect(res.statusCode, res.body).toBe(201);
    const document = CourseDocument.parse(res.json());
    expect(document).toMatchObject({ title: "formulaire", kind: "markdown", canDelete: true });
    expect(document.warnings.map((w) => w.code)).toEqual(["raw_html", "target_missing"]);
    const [row] = await db().select().from(courseDocuments).where(eq(courseDocuments.id, document.id));
    expect(row!.html).toContain("&lt;b&gt;");
    expect(row!.html).not.toContain("<img");
    expect(row!.toc).toEqual([{ id: "formulaire", depth: 1, text: "Formulaire" }]);
    expect(row!.renderedWith).toBeGreaterThan(0);
  });

  it("refuses what is neither: 415, and nothing stored", async () => {
    const id = await course();
    const refused = [
      await upload(id, Buffer.from("# Notes\n"), "notes.txt"),
      await upload(id, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image.md"),
      await upload(id, Buffer.from("text\u0000with a NUL"), "nul.md"),
      await upload(id, Buffer.from([0xc3, 0x28]), "latin.md"),
    ];
    for (const res of refused) expect(res.json(), res.body).toMatchObject({ error: "document_unsupported" });
    expect(refused.map((r) => r.statusCode)).toEqual([415, 415, 415, 415]);
    expect(
      (await server.app.inject({ method: "POST", url: base(id), headers: owner.headers, payload: {} })).statusCode,
    ).toBe(415);
    expect((await library(id)).documents).toEqual([]);
  });

  it("refuses a file past the cap with 413, its limit in the body", async () => {
    const id = await course();
    const res = await upload(id, pdf(undefined, MAX + 100));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: "file_too_large", maxBytes: MAX });
    expect((await library(id)).documents).toEqual([]);
    expect(await readdir(join(server.assetsDir, "documents/tmp"))).toEqual([]);
  });

  it("answers the existing document for the same bytes twice in one course", async () => {
    const id = await course();
    const bytes = pdf();
    const first = await upload(id, bytes, "a.pdf");
    const second = await upload(id, bytes, "b.pdf", assistant);
    expect([first.statusCode, second.statusCode]).toEqual([201, 200]);
    expect(second.json().id).toBe(first.json().id);
    expect(second.json()).toMatchObject({ filename: "a.pdf", canDelete: false });
    expect((await library(id)).usedBytes).toBe(bytes.length);
  });

  it("stores the same bytes in two courses as two rows and one file, and answers both alike", async () => {
    const [one, two] = [await course(), await course()];
    const bytes = pdf();
    const a = await upload(one, bytes, "same.pdf");
    const b = await upload(two, bytes, "same.pdf");
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    const strip = (body: Record<string, unknown>) => ({ ...body, id: undefined, uploadedAt: undefined });
    expect(strip(b.json())).toEqual(strip(a.json()));
    const rows = await db().select().from(courseDocuments).where(eq(courseDocuments.sha256, (await db().select().from(courseDocuments).where(eq(courseDocuments.id, a.json().id)))[0]!.sha256));
    expect(rows.map((r) => r.courseId).sort()).toEqual([one, two].sort());
    const shard = dirname(fileOf(rows[0]!.sha256));
    expect((await readdir(shard)).filter((name) => name === rows[0]!.sha256)).toHaveLength(1);
    // Each course counts it in full.
    expect((await library(one)).usedBytes).toBe(bytes.length);
    expect((await library(two)).usedBytes).toBe(bytes.length);
  });
});

describe("the quota (F-ADMIN-10)", () => {
  it("defaults to 100 MB", async () => {
    expect((await library(await course())).quotaBytes).toBe(DEFAULT_DOCUMENTS_QUOTA_BYTES);
  });

  it("refuses an upload that would go past it: 409 with what is used", async () => {
    const id = await course(200);
    expect((await upload(id, pdf(undefined, 150))).statusCode).toBe(201);
    const res = await upload(id, pdf(undefined, 100));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "quota_exceeded", usedBytes: 150, quotaBytes: 200 });
    // The same bytes again spend nothing: the existing document, even over quota.
    expect((await library(id)).documents).toHaveLength(1);
  });

  it("lets one of two simultaneous uploads through when both do not fit", async () => {
    const id = await course(150);
    const replies = await Promise.all([upload(id, pdf(undefined, 100)), upload(id, pdf(undefined, 100))]);
    expect(replies.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect((await library(id)).usedBytes).toBe(100);
  });

  it("is an administrator's to set, on a course they reach, audited", async () => {
    const id = await course();
    const url = `/app/api/admin/courses/${id}/documents-quota`;
    const patch = (who: Actor, quotaBytes: unknown) =>
      server.app.inject({ method: "PATCH", url, headers: who.headers, payload: { quotaBytes } });
    expect((await patch(owner, 1)).statusCode).toBe(403);
    // An administrator without a seat nor Super Powers does not reach the course.
    expect((await patch(admin, 1)).statusCode).toBe(404);
    const powered = await server.signInWithSuperPowers();
    expect((await patch(powered, -1)).statusCode).toBe(400);
    expect((await patch(powered, 11 * 1024 ** 3)).statusCode).toBe(400);
    const res = await patch(powered, 500_000_000);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ quotaBytes: 500_000_000 });
    expect((await library(id)).quotaBytes).toBe(500_000_000);
    const rows = await db()
      .select({ actor: auditLog.actorUserId, payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.action, "course.documents_quota"), eq(auditLog.subjectId, id)));
    expect(rows).toEqual([{ actor: powered.id, payload: { from: DEFAULT_DOCUMENTS_QUOTA_BYTES, to: 500_000_000 } }]);
  });
});

describe("rename and delete", () => {
  it("renames for any member of the staff; refuses an empty title", async () => {
    const id = await course();
    const doc = (await upload(id, pdf())).json();
    const url = `${base(id)}/${doc.id}`;
    const res = await server.app.inject({ method: "PATCH", url, headers: assistant.headers, payload: { title: "  Fiche de cours  " } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ title: "Fiche de cours", canDelete: false });
    expect((await server.app.inject({ method: "PATCH", url, headers: owner.headers, payload: { title: " " } })).statusCode).toBe(400);
    const [audit] = await db().select().from(auditLog).where(and(eq(auditLog.action, "course.document_rename"), eq(auditLog.subjectId, id)));
    expect(audit!.payload).toMatchObject({ documentId: doc.id, title: "Fiche de cours", from: "sheet", kind: "pdf" });
  });

  it("deletes for the uploader or an owner; refuses another assistant with 403 owner_required", async () => {
    const id = await course();
    const mine = (await upload(id, pdf(), "a.pdf", assistant)).json();
    // Newest first: the second upload a minute later, never at the same instant.
    server.clock.advance(60_000);
    const theirs = (await upload(id, pdf(), "b.pdf", colleague)).json();
    const del = (docId: string, who: Actor) =>
      server.app.inject({ method: "DELETE", url: `${base(id)}/${docId}`, headers: who.headers });
    const refused = await del(theirs.id, assistant);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "owner_required" });
    expect((await library(id, assistant)).documents.map((d) => [d.filename, d.canDelete])).toEqual([
      ["b.pdf", false],
      ["a.pdf", true],
    ]);
    expect((await del(mine.id, assistant)).statusCode).toBe(204);
    expect((await del(theirs.id, owner)).statusCode).toBe(204);
    expect((await library(id)).documents).toEqual([]);
    const actions = await db().select({ payload: auditLog.payload }).from(auditLog)
      .where(and(eq(auditLog.action, "course.document_delete"), eq(auditLog.subjectId, id)));
    expect(actions).toHaveLength(2);
  });

  it("never unlinks the file: the delete touches its time", async () => {
    const id = await course();
    const doc = (await upload(id, pdf())).json();
    const [row] = await db().select().from(courseDocuments).where(eq(courseDocuments.id, doc.id));
    await utimes(fileOf(row!.sha256), new Date("2020-01-01"), new Date("2020-01-01"));
    server.clock.advance(60_000);
    await server.app.inject({ method: "DELETE", url: `${base(id)}/${doc.id}`, headers: owner.headers });
    expect((await stat(fileOf(row!.sha256))).mtime).toEqual(server.clock.now());
  });
});

describe("the sweep (library.blob_sweep)", () => {
  it("removes an orphan past the grace, keeps a named file and a recent orphan", async () => {
    const id = await course();
    const kept = (await upload(id, pdf())).json();
    const [keptRow] = await db().select().from(courseDocuments).where(eq(courseDocuments.id, kept.id));
    const old = new Date(server.clock.now().getTime() - SWEEP_GRACE_MS - 60_000);
    await utimes(fileOf(keptRow!.sha256), old, old);
    const orphan = async (at: Date) => {
      const sha = randomUUID().replaceAll("-", "").padEnd(64, "0");
      await mkdir(dirname(fileOf(sha)), { recursive: true });
      await writeFile(fileOf(sha), "orphan");
      await utimes(fileOf(sha), at, at);
      return sha;
    };
    const stale = await orphan(old);
    const recent = await orphan(server.clock.now());
    // A deleted document whose bytes another course still names.
    const other = await course();
    const shared = pdf();
    const a = (await upload(id, shared)).json();
    await upload(other, shared);
    await server.app.inject({ method: "DELETE", url: `${base(id)}/${a.id}`, headers: owner.headers });
    const [sharedRow] = await db().select().from(courseDocuments).where(eq(courseDocuments.courseId, other));
    await utimes(fileOf(sharedRow!.sha256), old, old);

    expect(await sweepDocumentFiles(db(), server.assetsDir, server.clock.now())).toBeGreaterThanOrEqual(1);
    const exists = (sha: string) => stat(fileOf(sha)).then(() => true, () => false);
    expect(await exists(stale)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await exists(keptRow!.sha256)).toBe(true);
    expect(await exists(sharedRow!.sha256)).toBe(true);
  });

  it("keeps a file a row came to name between the listing and the removal", async () => {
    const id = await course();
    const bytes = pdf();
    const doc = (await upload(id, bytes)).json();
    const [row] = await db().select().from(courseDocuments).where(eq(courseDocuments.id, doc.id));
    const sha = row!.sha256;
    // Unnamed and old: a candidate when the sweep lists the store.
    await db().delete(courseDocuments).where(eq(courseDocuments.id, doc.id));
    const old = new Date(server.clock.now().getTime() - SWEEP_GRACE_MS - 60_000);
    await utimes(fileOf(sha), old, old);
    const candidate = (await sweepCandidates(db(), server.assetsDir, server.clock.now())).find((c) => c.sha256 === sha);
    expect(candidate).toBeDefined();
    // The same bytes uploaded again before the sweep reaches the file.
    await db().insert(courseDocuments).values({ ...row!, id: randomUUID() });
    expect(await removeIfUnnamed(db(), candidate!, server.clock.now())).toBe(false);
    expect(await readFile(fileOf(sha))).toEqual(bytes);
    // Unnamed again: now it goes.
    await db().delete(courseDocuments).where(eq(courseDocuments.sha256, sha));
    expect(await removeIfUnnamed(db(), candidate!, server.clock.now())).toBe(true);
    await expect(stat(fileOf(sha))).rejects.toThrow();
  });
});

describe("the file (Range, inert headers)", () => {
  it("serves the exact bytes, whole or ranged, as an inert attachment", async () => {
    const id = await course();
    const bytes = pdf(undefined, 1000);
    const doc = (await upload(id, bytes, "Norme été.pdf")).json();
    const url = `${base(id)}/${doc.id}/file`;
    const whole = await get(url);
    expect(whole.statusCode).toBe(200);
    expect(whole.rawPayload).toEqual(bytes);
    expect(whole.headers).toMatchObject({
      "content-type": "application/pdf",
      "content-length": "1000",
      "accept-ranges": "bytes",
      "content-disposition": "attachment; filename=\"Norme _t_.pdf\"; filename*=UTF-8''Norme%20%C3%A9t%C3%A9.pdf",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; sandbox",
    });
    const part = await get(url, owner, { range: "bytes=10-19" });
    expect(part.statusCode).toBe(206);
    expect(part.headers).toMatchObject({ "content-range": "bytes 10-19/1000", "content-length": "10" });
    expect(part.rawPayload).toEqual(bytes.subarray(10, 20));
    const tail = await get(url, owner, { range: "bytes=-5" });
    expect(tail.rawPayload).toEqual(bytes.subarray(995));
    const past = await get(url, owner, { range: "bytes=1000-" });
    expect(past.statusCode).toBe(416);
    expect(past.headers["content-range"]).toBe("bytes */1000");
    const multi = await get(url, owner, { range: "bytes=0-1,5-6" });
    expect(multi.statusCode).toBe(200);
    expect(multi.rawPayload).toEqual(bytes);
  });

  it("says when the row outlived its file, in the list and on the file", async () => {
    const id = await course();
    const doc = (await upload(id, pdf())).json();
    const [row] = await db().select().from(courseDocuments).where(eq(courseDocuments.id, doc.id));
    await rm(fileOf(row!.sha256));
    expect((await library(id)).documents[0]).toMatchObject({ id: doc.id, missing: true });
    const res = await get(`${base(id)}/${doc.id}/file`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "file_missing" });
  });
});

describe("a Markdown document's HTML (the viewer, ADR-144 §6)", () => {
  const source = "# Formulaire\n\n## Lois\n\n<b>gras</b> et $U = RI$.\n\n## Unités\n";

  it("answers the staff the stored rendering and its table of contents", async () => {
    const id = await course();
    const doc = CourseDocument.parse((await upload(id, Buffer.from(source), "formulaire.md")).json());
    for (const who of [owner, assistant]) {
      const res = await get(`${base(id)}/${doc.id}/html`, who);
      expect(res.statusCode, res.body).toBe(200);
      const body = DocumentHtml.strict().parse(res.json());
      expect(body.html).toContain('<h2 id="lois">Lois</h2>');
      // Raw HTML stays text, as rendered at upload.
      expect(body.html).toContain("&lt;b&gt;");
      expect(body.toc.map((e) => e.text)).toEqual(["Formulaire", "Lois", "Unités"]);
    }
  });

  it("has none for a PDF: the 404 of a missing document", async () => {
    const id = await course();
    const doc = (await upload(id, pdf())).json();
    const res = await get(`${base(id)}/${doc.id}/html`);
    expect({ status: res.statusCode, body: res.body }).toEqual({ status: 404, body: JSON.stringify({ error: "not_found" }) });
  });

  it("answers a document of another course, through a course the caller reaches, the 404 of a missing one", async () => {
    const id = await course();
    const other = await course();
    const doc = (await upload(id, Buffer.from(source), "formulaire.md")).json();
    const res = await get(`${base(other)}/${doc.id}/html`);
    expect({ status: res.statusCode, body: res.body }).toEqual({ status: 404, body: JSON.stringify({ error: "not_found" }) });
  });
});

describe("the re-rendering (library.blob_sweep, ADR-144 §3)", () => {
  /** A Markdown row as an older renderer left it: its file on disk, an old stamp and old HTML. */
  async function stale(courseId: string, source: string, renderedWith: number | null, withFile = true) {
    const doc = CourseDocument.parse((await upload(courseId, Buffer.from(source), `${randomUUID()}.md`)).json());
    const [row] = await db().select().from(courseDocuments).where(eq(courseDocuments.id, doc.id));
    await db()
      .update(courseDocuments)
      .set({ html: "<p>old</p>", toc: [], warnings: [], renderedWith })
      .where(eq(courseDocuments.id, doc.id));
    if (!withFile) await rm(fileOf(row!.sha256));
    return doc.id;
  }
  const rowOf = async (id: string) => (await db().select().from(courseDocuments).where(eq(courseDocuments.id, id)))[0]!;

  it("renders again, from the file, the Markdown an older renderer rendered; leaves the rest", async () => {
    const id = await course();
    const older = await stale(id, "# Old\n\n<i>x</i>\n", RENDERER_VERSION - 1);
    const unstamped = await stale(id, "# Unstamped\n", null);
    const current = await stale(id, "# Current\n", RENDERER_VERSION);
    const fileless = await stale(id, "# Gone\n", RENDERER_VERSION - 1, false);
    const pdfDoc = (await upload(id, pdf())).json();

    expect(await rerenderDocuments(db(), server.assetsDir, server.app.log)).toBeGreaterThanOrEqual(2);
    expect(await rowOf(older)).toMatchObject({ renderedWith: RENDERER_VERSION, toc: [{ id: "old", depth: 1, text: "Old" }] });
    expect((await rowOf(older)).html).toContain("&lt;i&gt;");
    expect((await rowOf(older)).warnings).toEqual([{ code: "raw_html" }]);
    expect(await rowOf(unstamped)).toMatchObject({ renderedWith: RENDERER_VERSION });
    // Current already: not touched. Its file gone: kept as it was, tried again next time.
    expect(await rowOf(current)).toMatchObject({ html: "<p>old</p>", renderedWith: RENDERER_VERSION });
    expect(await rowOf(fileless)).toMatchObject({ html: "<p>old</p>", renderedWith: RENDERER_VERSION - 1 });
    expect(await rowOf(pdfDoc.id)).toMatchObject({ html: null, renderedWith: null });
    // Once caught up, nothing more to do.
    const again = await stale(id, "# Again\n", RENDERER_VERSION - 1);
    expect(await rerenderDocuments(db(), server.assetsDir, server.app.log)).toBe(1);
    expect(await rowOf(again)).toMatchObject({ renderedWith: RENDERER_VERSION });
  });

  it("goes on past a document whose rendering throws, keeping that one's", async () => {
    const id = await course();
    const broken = await stale(id, "# Broken\n", RENDERER_VERSION - 1);
    const fine = await stale(id, "# Fine\n", RENDERER_VERSION - 1);
    const warn = vi.fn();
    const render = (source: string) => {
      if (source.includes("Broken")) throw new Error("renderer crashed");
      return renderStandalone(source);
    };
    expect(await rerenderDocuments(db(), server.assetsDir, { warn }, render)).toBeGreaterThanOrEqual(1);
    expect(await rowOf(broken)).toMatchObject({ html: "<p>old</p>", renderedWith: RENDERER_VERSION - 1 });
    expect(await rowOf(fine)).toMatchObject({ renderedWith: RENDERER_VERSION });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ documentId: broken, error: "renderer crashed" }), "document re-rendering failed");
  });

  it("sweeps the files even when the re-rendering cannot run at all", async () => {
    const orphan = join(server.assetsDir, documentPath("f".repeat(64)));
    await mkdir(dirname(orphan), { recursive: true });
    await writeFile(orphan, "orphan");
    const longAgo = new Date(server.app.clock.now().getTime() - 2 * SWEEP_GRACE_MS);
    await utimes(orphan, longAgo, longAgo);
    const task = LIBRARY_TASKS.find((t) => t.key === "library.blob_sweep")!;
    // A database the re-rendering's first query fails on, the sweep's own reads intact.
    const db = server.app.db;
    const select = db.select.bind(db);
    let calls = 0;
    const spy = vi.spyOn(db, "select").mockImplementation(((...args: Parameters<typeof select>) => {
      calls += 1;
      if (calls === 1) throw new Error("database gone");
      return select(...args);
    }) as typeof db.select);
    try {
      const summary = await task.run(server.app, { ASSETS_DIR: server.assetsDir } as AppConfig);
      expect(summary).toMatch(/^documents not rendered again, \d+ document files swept$/);
    } finally {
      spy.mockRestore();
    }
    expect(await stat(orphan).catch(() => null)).toBeNull();
  });

  it("is a step of the library's daily task, never of a read", async () => {
    const id = await course();
    const doc = await stale(id, "# Daily\n", RENDERER_VERSION - 1);
    // A read serves what is stored.
    expect(DocumentHtml.parse((await get(`${base(id)}/${doc}/html`)).json()).html).toBe("<p>old</p>");
    const task = LIBRARY_TASKS.find((t) => t.key === "library.blob_sweep")!;
    const summary = await task.run(server.app, { ASSETS_DIR: server.assetsDir } as AppConfig);
    expect(summary).toMatch(/documents rendered again, \d+ document files swept$/);
    expect(DocumentHtml.parse((await get(`${base(id)}/${doc}/html`)).json()).html).toContain('<h1 id="daily">Daily</h1>');
  });
});

describe("who reaches the library (invariant 6)", () => {
  it("answers a teacher off the staff the 404 of a missing course or document, on every route", async () => {
    const id = await course();
    const doc = (await upload(id, pdf())).json();
    const sheet = (await upload(id, Buffer.from("# Sheet\n"), "sheet.md")).json();
    const missing = randomUUID();
    const pairs: [string, string, string][] = [
      ["GET", `${base(id)}/${sheet.id}/html`, `${base(missing)}/${sheet.id}/html`],
      ["GET", base(id), base(missing)],
      ["POST", base(id), base(missing)],
      ["PATCH", `${base(id)}/${doc.id}`, `${base(missing)}/${doc.id}`],
      ["DELETE", `${base(id)}/${doc.id}`, `${base(missing)}/${doc.id}`],
      ["GET", `${base(id)}/${doc.id}/file`, `${base(missing)}/${doc.id}/file`],
    ];
    for (const [method, real, absent] of pairs) {
      const ask = (url: string, who: Actor) =>
        server.app.inject({
          method: method as "GET",
          url,
          headers: who.headers,
          ...(method === "GET" || method === "DELETE" ? {} : { payload: { title: "x" } }),
        });
      const seen = await ask(real, stranger);
      expect({ status: seen.statusCode, body: seen.body }, `${method} ${real}`).toEqual({
        status: 404,
        body: JSON.stringify({ error: "not_found" }),
      });
      const absentSeen = await ask(absent, stranger);
      expect(absentSeen.statusCode).toBe(404);
    }
    expect((await library(id)).documents).toHaveLength(2);
    // A document of another course, through a course the caller does reach: the 404 of a missing document.
    const other = await course();
    const elsewhere = await get(`${base(other)}/${doc.id}/file`);
    expect({ status: elsewhere.statusCode, body: elsewhere.body }).toEqual({ status: 404, body: JSON.stringify({ error: "not_found" }) });
  });
});
