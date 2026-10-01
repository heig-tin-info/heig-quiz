/**
 * The Quiz-mode journal (ADR-057 §1, merge task M4-08): the database is the
 * content. Created with no GitHub at all; its pages saved, added, deleted and
 * restored, its assets uploaded, by the course's staff in the platform.
 *
 * **One mechanism for the rendering.** Every write runs in ONE transaction
 * that locks the journal's row (`SELECT … FOR UPDATE`, the lock the
 * ingestion's compare-and-set takes, J2), changes the source, then renders
 * the whole journal again from the database through `rendering.ts` — the
 * code the GitHub ingestion renders its fetched files with — so titles,
 * links between pages (a draft's path never linked for students), warnings,
 * `asset_paths` (J1, N-SEC-13) and `html_student` are what an ingestion of the
 * same files would produce. The row's `version` is bumped, as by every
 * writer of it.
 *
 * - **Lock**: a page's `version`; a save against another is 409 `conflict`,
 *   nothing written.
 * - **Paths** are set at creation and never change here (order and parent
 *   are M4-10's).
 * - **Revisions**: one per save, add and restore (the markdown and its front
 *   matter), no limit; they outlive the page's deletion, so a deleted page
 *   can be restored, and go with the journal (cascade). No student route
 *   reads them.
 * - **Assets** are append-only (`asset_exists` on another file at a path
 *   taken), `blob_sha` the sha256 of the bytes (the ETag), and collected by
 *   every write once no page references them and they are a day old: an
 *   upload waits for the save that references it.
 *
 * Every write is audited by the route's `note`, with `mode: "quiz"`.
 */
import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, lt, notInArray, sql } from "drizzle-orm";

import type { JournalDeletedPage, JournalFileWritten, JournalPageSave, JournalRevision, JournalStaff } from "@quiz/contracts";
import { assetContentType } from "@quiz/contracts";
import { cleanSource, prettifyName, renderPage } from "@quiz/docrender";
import { displayName } from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import { classroomJournals, journalAssets, journalPageRevisions, journalPages, users } from "../../db/schema.js";
import { journalChanged } from "./events.js";
import { renderSources, renderStudentPages, storePages } from "./rendering.js";
import { staffJournal, staffPage } from "./service.js";
import { freshVersion, JournalError, type Room, type WriteContext } from "./writes.js";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** How long an asset no page references is kept: the time between an upload and the save that references it. */
const ASSET_GRACE = sql`interval '1 day'`;

// ---------------------------------------------------------------- the write

/** The journal's row locked; refused unless it is a Quiz-mode one (GitHub mode is read-only, ADR-057). */
async function lockQuizJournal(tx: Tx, classroomId: string): Promise<void> {
  const [row] = await tx
    .select({ mode: classroomJournals.mode })
    .from(classroomJournals)
    .where(eq(classroomJournals.classroomId, classroomId))
    .for("update");
  if (!row) throw new JournalError("no_journal");
  if (row.mode !== "quiz") throw new JournalError("read_only");
}

/**
 * The whole journal rendered again from the database (`rendering.ts`), the
 * assets no page references collected past their grace, the student
 * rendering redone, the row's `version` bumped.
 */
async function rebuild(tx: Tx, classroomId: string, changed: string | null, now: Date): Promise<void> {
  const sources = await tx
    .select({ id: journalPages.id, path: journalPages.path, markdown: journalPages.markdown, blobSha: journalPages.blobSha })
    .from(journalPages)
    .where(eq(journalPages.classroomId, classroomId));
  const assets = await tx
    .select({ path: journalAssets.path })
    .from(journalAssets)
    .where(eq(journalAssets.classroomId, classroomId));
  const { pages, referenced } = renderSources(
    classroomId,
    sources.map((s) => ({ ...s, moved: s.path === changed })),
    new Set(assets.map((a) => a.path)),
  );
  await storePages(tx, classroomId, pages, now);
  await tx
    .delete(journalAssets)
    .where(
      and(
        eq(journalAssets.classroomId, classroomId),
        lt(journalAssets.createdAt, sql`now() - ${ASSET_GRACE}`),
        referenced.size ? notInArray(journalAssets.path, [...referenced]) : undefined,
      ),
    );
  await renderStudentPages(tx, classroomId);
  await tx
    .update(classroomJournals)
    .set({ version: sql`${classroomJournals.version} + 1`, updatedAt: now })
    .where(eq(classroomJournals.classroomId, classroomId));
}

/** The page at `path` as rendered, kept as a revision authored by `authorId`. */
async function recordRevision(tx: Tx, classroomId: string, path: string, authorId: string): Promise<void> {
  const [page] = await tx
    .select({ markdown: journalPages.markdown, frontMatter: journalPages.frontMatter })
    .from(journalPages)
    .where(and(eq(journalPages.classroomId, classroomId), eq(journalPages.path, path)));
  await tx.insert(journalPageRevisions).values({ id: randomUUID(), classroomId, path, ...page!, authorId });
}

/**
 * One Quiz-mode write: `change` under the journal's lock, then the journal
 * rendered again and, when `revise` names a page, its revision recorded —
 * all or nothing. Readers get a `journal` hint once it is committed.
 */
async function write<T>(
  ctx: WriteContext,
  classroomId: string,
  change: (tx: Tx, now: Date) => Promise<T>,
  revise: (result: T) => string | null,
  lock: (tx: Tx) => Promise<void> = (tx) => lockQuizJournal(tx, classroomId),
): Promise<T> {
  const now = ctx.app.clock.now();
  const result = await ctx.app.db.transaction(async (tx) => {
    await lock(tx);
    const out = await change(tx, now);
    const path = revise(out);
    await rebuild(tx, classroomId, path, now);
    if (path !== null) await recordRevision(tx, classroomId, path, ctx.userId);
    return out;
  });
  journalChanged([classroomId]);
  return result;
}

/** A new page's row; the rendering fills the rest. A random first `version`, like a new journal's (`freshVersion`). */
async function insertPage(tx: Tx, classroomId: string, path: string, markdown: string, now: Date): Promise<void> {
  await tx.insert(journalPages).values({
    id: randomUUID(),
    classroomId,
    path,
    parentPath: "",
    sortKey: "",
    blobSha: sha256(markdown),
    markdown,
    htmlStaff: "",
    htmlStudent: "",
    version: freshVersion(),
    updatedAt: now,
  });
}

/** A page's new source: its `version` bumped. */
async function rewritePage(tx: Tx, classroomId: string, path: string, markdown: string, now: Date): Promise<void> {
  await tx
    .update(journalPages)
    .set({ markdown, blobSha: sha256(markdown), version: sql`${journalPages.version} + 1`, updatedAt: now })
    .where(and(eq(journalPages.classroomId, classroomId), eq(journalPages.path, path)));
}

async function pageVersion(tx: Tx, classroomId: string, path: string): Promise<number | null> {
  const [page] = await tx
    .select({ version: journalPages.version })
    .from(journalPages)
    .where(and(eq(journalPages.classroomId, classroomId), eq(journalPages.path, path)));
  return page?.version ?? null;
}

/** What a page write answers: the page as it now reads, its `version` the next save's base. */
async function written(db: Db, classroomId: string, path: string): Promise<JournalFileWritten> {
  return { path, page: await staffPage(db, classroomId, path) };
}

// ---------------------------------------------------------------- create

/** The home page a new Quiz-mode journal starts with: the classroom's name as its title. */
const homeMarkdown = (room: Room) => `# ${room.name}\n`;

/**
 * `POST /classrooms/:id/journal` `{ mode: "quiz" }`: a journal held in Quiz,
 * needing no organization and no App, with its home page (`README.md`, as a
 * created repository's) and that page's first revision. A row that appeared
 * meanwhile (two tabs) wins: 409 `journal_exists`.
 */
export async function createQuizJournal(ctx: WriteContext, room: Room): Promise<JournalStaff> {
  const home = "README.md";
  await write(
    ctx,
    room.id,
    (tx, now) => insertPage(tx, room.id, home, homeMarkdown(room), now),
    () => home,
    async (tx) => {
      const inserted = await tx
        .insert(classroomJournals)
        .values({ classroomId: room.id, mode: "quiz", createdBy: ctx.userId, version: freshVersion(), syncStatus: "ok" })
        .onConflictDoNothing()
        .returning({ classroomId: classroomJournals.classroomId });
      if (inserted.length === 0) throw new JournalError("journal_exists");
    },
  );
  await ctx.note("journal.create", { mode: "quiz" });
  return staffJournal(ctx.app.db, room);
}

// ---------------------------------------------------------------- pages

/**
 * `PUT /classrooms/:id/journal/pages/*` (F-JRN-10): the page's new source,
 * against the version the editor opened. Another version, or a page deleted
 * meanwhile, is 409 `conflict` and writes nothing.
 */
export async function savePage(ctx: WriteContext, classroomId: string, path: string, body: JournalPageSave): Promise<JournalFileWritten> {
  const markdown = cleanSource(body.markdown);
  await write(
    ctx,
    classroomId,
    async (tx, now) => {
      if ((await pageVersion(tx, classroomId, path)) !== body.baseVersion) throw new JournalError("conflict");
      await rewritePage(tx, classroomId, path, markdown, now);
    },
    () => path,
  );
  const result = await written(ctx.app.db, classroomId, path);
  await ctx.note("journal.save", { mode: "quiz", path, version: result.page?.version ?? null });
  return result;
}

/** `POST /classrooms/:id/journal/pages` (F-JRN-10): a new page, empty or with its title as a heading. */
export async function addPage(
  ctx: WriteContext,
  classroomId: string,
  body: { path: string; title?: string | undefined },
): Promise<JournalFileWritten> {
  await write(
    ctx,
    classroomId,
    async (tx, now) => {
      if ((await pageVersion(tx, classroomId, body.path)) !== null) throw new JournalError("page_exists");
      await insertPage(tx, classroomId, body.path, body.title ? `# ${body.title}\n` : "", now);
    },
    () => body.path,
  );
  await ctx.note("journal.add", { mode: "quiz", path: body.path });
  return written(ctx.app.db, classroomId, body.path);
}

/**
 * `DELETE /classrooms/:id/journal/pages/*` (F-JRN-10): the page goes, its
 * revisions stay (restorable, `deletedPages`). False: no such page.
 */
export async function deletePage(ctx: WriteContext, classroomId: string, path: string): Promise<boolean> {
  const deleted = await write(
    ctx,
    classroomId,
    async (tx) =>
      (
        await tx
          .delete(journalPages)
          .where(and(eq(journalPages.classroomId, classroomId), eq(journalPages.path, path)))
          .returning({ id: journalPages.id })
      ).length > 0,
    () => null,
  );
  if (deleted) await ctx.note("journal.delete", { mode: "quiz", path });
  return deleted;
}

// ---------------------------------------------------------------- assets

/**
 * `POST /classrooms/:id/journal/assets/*` (F-JRN-11): a file at `path`,
 * referenced from a page by its relative path (`images/…` beside the page).
 * Append-only: the same bytes again change nothing; other bytes at a path
 * taken are 409 `asset_exists`. A page already referencing it now links it.
 */
export async function uploadAsset(ctx: WriteContext, classroomId: string, path: string, data: Buffer): Promise<JournalFileWritten> {
  const blobSha = sha256(data);
  const stored = await write(
    ctx,
    classroomId,
    async (tx) => {
      const [existing] = await tx
        .select({ blobSha: journalAssets.blobSha })
        .from(journalAssets)
        .where(and(eq(journalAssets.classroomId, classroomId), eq(journalAssets.path, path)));
      if (existing) {
        if (existing.blobSha !== blobSha) throw new JournalError("asset_exists");
        return false;
      }
      await tx.insert(journalAssets).values({
        id: randomUUID(),
        classroomId,
        path,
        blobSha,
        contentType: assetContentType(path),
        size: data.length,
        data,
      });
      return true;
    },
    () => null,
  );
  if (stored) await ctx.note("journal.upload", { mode: "quiz", path, bytes: data.length, blobSha });
  return { path, page: null };
}

// ---------------------------------------------------------------- revisions

/** `GET /classrooms/:id/journal/revisions/*`: a page's revisions, newest first — a deleted page's too. */
export async function revisions(db: Db, classroomId: string, path: string): Promise<JournalRevision[]> {
  const rows = await db
    .select({
      id: journalPageRevisions.id,
      path: journalPageRevisions.path,
      markdown: journalPageRevisions.markdown,
      createdAt: journalPageRevisions.createdAt,
      givenName: users.givenName,
      familyName: users.familyName,
    })
    .from(journalPageRevisions)
    .innerJoin(users, eq(users.id, journalPageRevisions.authorId))
    .where(and(eq(journalPageRevisions.classroomId, classroomId), eq(journalPageRevisions.path, path)))
    .orderBy(desc(journalPageRevisions.createdAt), desc(journalPageRevisions.id));
  return rows.map(({ givenName, familyName, createdAt, ...r }) => ({
    ...r,
    author: displayName({ givenName, familyName, email: null }) || null,
    createdAt: createdAt.toISOString(),
  }));
}

/**
 * `GET /classrooms/:id/journal/deleted`: the paths with revisions and no page,
 * newest first, each titled by its latest revision.
 */
export async function deletedPages(db: Db, classroomId: string): Promise<JournalDeletedPage[]> {
  const latest = await db
    .selectDistinctOn([journalPageRevisions.path], {
      path: journalPageRevisions.path,
      markdown: journalPageRevisions.markdown,
      savedAt: journalPageRevisions.createdAt,
    })
    .from(journalPageRevisions)
    .leftJoin(
      journalPages,
      and(eq(journalPages.classroomId, journalPageRevisions.classroomId), eq(journalPages.path, journalPageRevisions.path)),
    )
    .where(and(eq(journalPageRevisions.classroomId, classroomId), sql`${journalPages.id} IS NULL`))
    .orderBy(journalPageRevisions.path, desc(journalPageRevisions.createdAt));
  return latest
    .sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime())
    .map(({ path, markdown, savedAt }) => ({
      path,
      title: renderPage(markdown, {
        classroomId,
        pagePath: path,
        fallbackTitle: prettifyName(path),
        pages: new Set(),
        assets: new Set(),
      }).title,
      savedAt: savedAt.toISOString(),
    }));
}

/**
 * `POST /classrooms/:id/journal/restore`: the revision's markdown becomes its
 * page's source again — a save (a new revision, the version bumped, audited
 * as `journal.restore`), whatever the page's version now; a deleted page is
 * created again at its path. Null: no such revision in this journal.
 */
export async function restoreRevision(ctx: WriteContext, classroomId: string, revisionId: string): Promise<JournalFileWritten | null> {
  const [revision] = await ctx.app.db
    .select({ path: journalPageRevisions.path, markdown: journalPageRevisions.markdown })
    .from(journalPageRevisions)
    .where(and(eq(journalPageRevisions.classroomId, classroomId), eq(journalPageRevisions.id, revisionId)));
  if (!revision) return null;
  const { path, markdown } = revision;
  await write(
    ctx,
    classroomId,
    async (tx, now) => {
      if ((await pageVersion(tx, classroomId, path)) === null) await insertPage(tx, classroomId, path, markdown, now);
      else await rewritePage(tx, classroomId, path, markdown, now);
    },
    () => path,
  );
  await ctx.note("journal.restore", { mode: "quiz", path, revisionId });
  return written(ctx.app.db, classroomId, path);
}
