/**
 * The Quiz-mode journal (ADR-057 §1, merge task M4-08): the database is the
 * content. Created with no GitHub at all; its pages saved, added, deleted and
 * restored, its assets uploaded, by the course's staff in the platform.
 *
 * **One mechanism for the rendering.** Every write runs in ONE transaction
 * that locks the journal's row (`SELECT … FOR UPDATE`, the lock the
 * ingestion's compare-and-set takes, J2), then renders the whole journal
 * again — the stored pages with the write's new source in place — through
 * `rendering.ts`, the code the GitHub ingestion renders its fetched files
 * with: titles, links between pages (a draft's path never linked for
 * students), warnings, `asset_paths` (J1, N-SEC-13) and `html_student` are
 * what an ingestion of the same files would produce. The row's `version` is
 * bumped, as by every writer of it.
 *
 * - **Lock**: a page's `version`; a save against another is 409 `conflict`,
 *   nothing written. The page a write answers is read in its transaction:
 *   its `version` is that write's own, the next save's `baseVersion`.
 * - **Paths** are set at creation and never change here (rename, order and
 *   nesting are not built).
 * - **Revisions**: one per save, add and restore (the markdown and its front
 *   matter), no limit; they outlive the page's deletion, so a deleted page
 *   can be restored, and go with the journal (cascade). No student route
 *   reads them.
 * - **Assets** are append-only (`asset_exists` on other bytes at a path
 *   taken), `blob_sha` the sha256 of the bytes (the ETag), and kept until
 *   the journal is removed: a revision restored finds its images again.
 *
 * Every write is audited by the route's `note`, with `mode: "quiz"`.
 */
import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";

import type {
  JournalDeletedPage,
  JournalFileWritten,
  JournalPageSave,
  JournalRevision,
  JournalRevisionContent,
  JournalStaff,
} from "@quiz/contracts";
import { assetContentType } from "@quiz/contracts";
import { cleanSource } from "@quiz/docrender";
import { displayName } from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import { classroomJournals, journalAssets, journalPageRevisions, journalPages, users } from "../../db/schema.js";
import { JournalError } from "./errors.js";
import { journalChanged } from "./events.js";
import { renderAt, renderSources, renderStudentPages, storePages, type PageSource } from "./rendering.js";
import { staffJournal, staffPage } from "./service.js";
import { freshVersion, type Room, type WriteContext } from "./writes.js";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** What a write does to the pages: a page's new source, a page gone, or nothing (an upload). */
type Edit = { path: string; markdown: string } | { path: string; deleted: true } | null;

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

/** The page's `version`, null when there is no page at `path`. */
async function pageVersion(tx: Tx, classroomId: string, path: string): Promise<number | null> {
  const [page] = await tx
    .select({ version: journalPages.version })
    .from(journalPages)
    .where(and(eq(journalPages.classroomId, classroomId), eq(journalPages.path, path)));
  return page?.version ?? null;
}

/**
 * `edit` applied with the journal's row locked: the whole journal rendered
 * again with it, the student rendering redone, the row's `version` bumped; a
 * new source bumps its page's `version` (a new page starts at a random one,
 * as a new journal does) and is kept as a revision. Answers what the write
 * returns, read in the transaction.
 */
async function apply(tx: Tx, ctx: WriteContext, classroomId: string, edit: Edit, now: Date): Promise<JournalFileWritten | null> {
  const stored = await tx
    .select({ id: journalPages.id, path: journalPages.path, markdown: journalPages.markdown, blobSha: journalPages.blobSha })
    .from(journalPages)
    .where(eq(journalPages.classroomId, classroomId));
  const sources: PageSource[] = stored
    .filter((s) => s.path !== edit?.path)
    .map((s) => ({ ...s, moved: false }));
  const before = stored.find((s) => s.path === edit?.path);
  if (edit && "markdown" in edit) {
    const { path, markdown } = edit;
    sources.push({ id: before?.id ?? randomUUID(), path, markdown, blobSha: sha256(markdown), moved: true });
  }
  const assets = await tx.select({ path: journalAssets.path }).from(journalAssets).where(eq(journalAssets.classroomId, classroomId));
  const { pages } = renderSources(classroomId, sources, new Set(assets.map((a) => a.path)));
  const created = edit && "markdown" in edit && !before ? edit.path : null;
  await storePages(tx, classroomId, pages.map((p) => (p.path === created ? { ...p, version: freshVersion() } : p)), now);
  await renderStudentPages(tx, classroomId);
  await tx
    .update(classroomJournals)
    .set({ version: sql`${classroomJournals.version} + 1`, updatedAt: now })
    .where(eq(classroomJournals.classroomId, classroomId));
  if (!edit || !("markdown" in edit)) return null;

  if (before) {
    await tx
      .update(journalPages)
      .set({ version: sql`${journalPages.version} + 1` })
      .where(and(eq(journalPages.classroomId, classroomId), eq(journalPages.path, edit.path)));
  }
  const rendered = pages.find((p) => p.path === edit.path)!;
  await tx.insert(journalPageRevisions).values({
    id: randomUUID(),
    classroomId,
    path: edit.path,
    markdown: edit.markdown,
    frontMatter: rendered.frontMatter ?? {},
    authorId: ctx.userId,
  });
  return { path: edit.path, page: await staffPage(tx, classroomId, edit.path) };
}

/**
 * One Quiz-mode write: the journal locked, `decide` reads what it needs and
 * says what to change (or refuses), then {@link apply}. `false` from
 * `decide`: nothing to do, nothing written. Readers get a `journal` hint
 * once it is committed.
 */
async function write(
  ctx: WriteContext,
  classroomId: string,
  decide: (tx: Tx) => Promise<Edit | false>,
): Promise<JournalFileWritten | null | false> {
  const now = ctx.app.clock.now();
  const result = await ctx.app.db.transaction(async (tx) => {
    await lockQuizJournal(tx, classroomId);
    const edit = await decide(tx);
    return edit === false ? false : apply(tx, ctx, classroomId, edit, now);
  });
  if (result !== false) journalChanged([classroomId]);
  return result;
}

/** A write of one page's source: it always answers the page. */
async function writePage(
  ctx: WriteContext,
  classroomId: string,
  decide: (tx: Tx) => Promise<{ path: string; markdown: string }>,
): Promise<JournalFileWritten> {
  const result = await write(ctx, classroomId, decide);
  if (!result) throw new Error("a page write answers its page");
  return result;
}

// ---------------------------------------------------------------- create

/** The home page a new Quiz-mode journal starts with, as a created repository's: `README.md`. */
const HOME = "README.md";

/**
 * `POST /classrooms/:id/journal` `{ mode: "quiz" }`: a journal held in Quiz,
 * needing no organization and no App, with its home page (the classroom's
 * name as its title) and that page's first revision. A row that appeared
 * meanwhile (two tabs) wins: 409 `journal_exists`.
 */
export async function createQuizJournal(ctx: WriteContext, room: Room): Promise<JournalStaff> {
  await ctx.app.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(classroomJournals)
      .values({ classroomId: room.id, mode: "quiz", createdBy: ctx.userId, version: freshVersion(), syncStatus: "ok" })
      .onConflictDoNothing()
      .returning({ classroomId: classroomJournals.classroomId });
    if (inserted.length === 0) throw new JournalError("journal_exists");
    await apply(tx, ctx, room.id, { path: HOME, markdown: `# ${room.name}\n` }, ctx.app.clock.now());
  });
  journalChanged([room.id]);
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
  const result = await writePage(ctx, classroomId, async (tx) => {
    if ((await pageVersion(tx, classroomId, path)) !== body.baseVersion) throw new JournalError("conflict");
    return { path, markdown: cleanSource(body.markdown) };
  });
  await ctx.note("journal.save", { mode: "quiz", path, version: result.page?.version ?? null });
  return result;
}

/** `POST /classrooms/:id/journal/pages` (F-JRN-10): a new page, empty or with its title as a heading. */
export async function addPage(
  ctx: WriteContext,
  classroomId: string,
  body: { path: string; title?: string | undefined },
): Promise<JournalFileWritten> {
  const result = await writePage(ctx, classroomId, async (tx) => {
    if ((await pageVersion(tx, classroomId, body.path)) !== null) throw new JournalError("page_exists");
    return { path: body.path, markdown: body.title ? `# ${body.title}\n` : "" };
  });
  await ctx.note("journal.add", { mode: "quiz", path: body.path });
  return result;
}

/**
 * `DELETE /classrooms/:id/journal/pages/*` (F-JRN-10): the page goes, its
 * revisions stay (restorable, {@link deletedPages}). False: no such page.
 */
export async function deletePage(ctx: WriteContext, classroomId: string, path: string): Promise<boolean> {
  const result = await write(ctx, classroomId, async (tx) =>
    (await pageVersion(tx, classroomId, path)) === null ? false : { path, deleted: true },
  );
  if (result === false) return false;
  await ctx.note("journal.delete", { mode: "quiz", path });
  return true;
}

// ---------------------------------------------------------------- assets

/**
 * `POST /classrooms/:id/journal/assets/*` (F-JRN-11): a file at `path`,
 * referenced from a page by its relative path (`images/…` beside the page).
 * Append-only: the same bytes again change nothing (no rendering, no
 * event); other bytes at a path taken are 409 `asset_exists`. A page
 * already referencing it now links it.
 */
export async function uploadAsset(ctx: WriteContext, classroomId: string, path: string, data: Buffer): Promise<JournalFileWritten> {
  const blobSha = sha256(data);
  const answer = { path, page: null };
  const [same] = await ctx.app.db
    .select({ id: journalAssets.id })
    .from(journalAssets)
    .innerJoin(classroomJournals, eq(classroomJournals.classroomId, journalAssets.classroomId))
    .where(
      and(
        eq(journalAssets.classroomId, classroomId),
        eq(journalAssets.path, path),
        eq(journalAssets.blobSha, blobSha),
        eq(classroomJournals.mode, "quiz"),
      ),
    );
  if (same) return answer;
  await write(ctx, classroomId, async (tx) => {
    const inserted = await tx
      .insert(journalAssets)
      .values({ id: randomUUID(), classroomId, path, blobSha, contentType: assetContentType(path), size: data.length, data })
      .onConflictDoNothing()
      .returning({ id: journalAssets.id });
    if (inserted.length === 0) throw new JournalError("asset_exists");
    return null;
  });
  await ctx.note("journal.upload", { mode: "quiz", path, bytes: data.length, blobSha });
  return answer;
}

// ---------------------------------------------------------------- revisions

const revisionColumns = {
  id: journalPageRevisions.id,
  path: journalPageRevisions.path,
  createdAt: journalPageRevisions.createdAt,
  givenName: users.givenName,
  familyName: users.familyName,
};

function revisionOf(r: { id: string; path: string; createdAt: Date; givenName: string | null; familyName: string | null }): JournalRevision {
  return {
    id: r.id,
    path: r.path,
    author: displayName({ givenName: r.givenName, familyName: r.familyName, email: null }) || null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** `GET /classrooms/:id/journal/revisions/*`: a page's revisions, newest first — a deleted page's too. */
export async function revisions(db: Db, classroomId: string, path: string): Promise<JournalRevision[]> {
  const rows = await db
    .select(revisionColumns)
    .from(journalPageRevisions)
    .innerJoin(users, eq(users.id, journalPageRevisions.authorId))
    .where(and(eq(journalPageRevisions.classroomId, classroomId), eq(journalPageRevisions.path, path)))
    .orderBy(desc(journalPageRevisions.createdAt), desc(journalPageRevisions.id));
  return rows.map(revisionOf);
}

/** `GET /classrooms/:id/journal/revision/:revisionId`: one revision with its markdown; null: not this journal's. */
export async function revision(db: Db, classroomId: string, revisionId: string): Promise<JournalRevisionContent | null> {
  const [row] = await db
    .select({ ...revisionColumns, markdown: journalPageRevisions.markdown })
    .from(journalPageRevisions)
    .innerJoin(users, eq(users.id, journalPageRevisions.authorId))
    .where(and(eq(journalPageRevisions.classroomId, classroomId), eq(journalPageRevisions.id, revisionId)));
  return row ? { ...revisionOf(row), markdown: row.markdown } : null;
}

/**
 * `GET /classrooms/:id/journal/deleted`: the paths with revisions and no page,
 * newest first, each titled by its latest revision.
 */
export async function deletedPages(db: Db, classroomId: string): Promise<JournalDeletedPage[]> {
  const latest = await db
    .selectDistinctOn([journalPageRevisions.path], {
      path: journalPageRevisions.path,
      revisionId: journalPageRevisions.id,
      markdown: journalPageRevisions.markdown,
      savedAt: journalPageRevisions.createdAt,
    })
    .from(journalPageRevisions)
    .leftJoin(
      journalPages,
      and(eq(journalPages.classroomId, journalPageRevisions.classroomId), eq(journalPages.path, journalPageRevisions.path)),
    )
    .where(and(eq(journalPageRevisions.classroomId, classroomId), sql`${journalPages.id} IS NULL`))
    .orderBy(journalPageRevisions.path, desc(journalPageRevisions.createdAt), desc(journalPageRevisions.id));
  const none = new Set<string>();
  return latest
    .sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime())
    .map(({ path, revisionId, markdown, savedAt }) => ({
      path,
      title: renderAt(classroomId, path, markdown, none, none).title,
      revisionId,
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
  const [found] = await ctx.app.db
    .select({ path: journalPageRevisions.path, markdown: journalPageRevisions.markdown })
    .from(journalPageRevisions)
    .where(and(eq(journalPageRevisions.classroomId, classroomId), eq(journalPageRevisions.id, revisionId)));
  if (!found) return null;
  const result = await writePage(ctx, classroomId, async () => found);
  await ctx.note("journal.restore", { mode: "quiz", path: found.path, revisionId });
  return result;
}
