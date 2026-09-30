/**
 * The `journal` module (ADR-049 and its addendum, spec 05 §5.11,
 * docs/merge/04-journal.md): a classroom's course documentation, held in a
 * GitHub repository and copied into `classroom_journals`, `journal_pages`
 * and `journal_assets`, which this module alone writes.
 *
 * This entry is what the routes and the other modules call: whether a
 * classroom has a journal (the student's classroom page), the STAFF
 * payloads, an asset, and the request of an ingestion. The student payloads
 * are `studentView.ts`'s, the journal's one exit towards a student
 * (invariant 4). Reads never touch GitHub: a page view is a SELECT, and a
 * GitHub outage leaves the journal readable (N-RES-07).
 */
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import type { JournalPageStaff, JournalRepository, JournalStaff } from "@quiz/contracts";
import { buildNav, homePage, journalRepoName } from "@quiz/docrender";

import { isoOrNull } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { classroomJournals, journalAssets, journalPages } from "../../db/schema.js";
import { JOURNAL_INGEST_QUEUE } from "../../jobs.js";
import type { ClassroomPayload } from "../guards.js";
import { ingestJournal } from "./ingest.js";
import { studentMayFetch, visibleToStudents } from "./studentView.js";

type JournalRow = typeof classroomJournals.$inferSelect;

/** Whether the classroom has a journal (F-JRN-01): its Journal tab exists exactly then. */
export async function hasJournal(db: Db, classroomId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: classroomJournals.classroomId })
    .from(classroomJournals)
    .where(eq(classroomJournals.classroomId, classroomId));
  return row !== undefined;
}

async function journalRow(db: Db, classroomId: string): Promise<JournalRow | null> {
  const [row] = await db
    .select()
    .from(classroomJournals)
    .where(eq(classroomJournals.classroomId, classroomId));
  return row ?? null;
}

/** Not served to students right now: the negation of THE predicate. */
const hiddenFromStudents = () => sql<boolean>`NOT (${visibleToStudents()})`;

function repositoryView(row: JournalRow): JournalRepository {
  return {
    fullName: row.fullName,
    ref: row.ref,
    rootPath: row.rootPath,
    htmlUrl: `https://github.com/${row.fullName}`,
    syncStatus: row.syncStatus,
    syncError: row.syncError,
    lastSyncedAt: isoOrNull(row.lastSyncedAt),
    lastCommitSha: row.lastCommitSha,
    // Nothing can be written before the copy knows the head it writes over.
    editable: row.syncStatus === "ok" && row.lastCommitSha !== null,
  };
}

/** `GET /classrooms/:id/journal` for the staff: every page, what students do not see, the sync state. */
export async function staffJournal(db: Db, room: { id: string; name: string }): Promise<JournalStaff> {
  const row = await journalRow(db, room.id);
  if (!row) {
    return {
      view: "staff",
      repository: null,
      nav: [],
      homePath: null,
      hiddenPaths: [],
      warningCount: 0,
      proposedName: journalRepoName(room.name),
    };
  }
  const pages = await db
    .select({
      path: journalPages.path,
      parentPath: journalPages.parentPath,
      sortKey: journalPages.sortKey,
      title: journalPages.title,
      hidden: hiddenFromStudents(),
      warned: sql<boolean>`jsonb_array_length(${journalPages.warnings}) > 0`,
    })
    .from(journalPages)
    .where(eq(journalPages.classroomId, room.id));
  return {
    view: "staff",
    repository: repositoryView(row),
    nav: buildNav(pages),
    homePath: homePage(pages)?.path ?? null,
    hiddenPaths: pages.filter((p) => p.hidden).map((p) => p.path).sort(),
    warningCount: pages.filter((p) => p.warned).length,
    proposedName: null,
  };
}

/** `GET /classrooms/:id/journal/pages/*` for the staff: the page, its source and its lock. */
export async function staffPage(db: Db, classroomId: string, path: string): Promise<JournalPageStaff | null> {
  const [page] = await db
    .select({ page: journalPages, hidden: hiddenFromStudents() })
    .from(journalPages)
    .where(and(eq(journalPages.classroomId, classroomId), eq(journalPages.path, path)));
  if (!page) return null;
  const p = page.page;
  return {
    view: "staff",
    path: p.path,
    title: p.title,
    html: p.htmlStaff,
    toc: p.toc,
    updatedAt: p.updatedAt.toISOString(),
    draft: p.draft,
    visibleFrom: isoOrNull(p.visibleFrom),
    hidden: page.hidden,
    markdown: p.markdown,
    blobSha: p.blobSha,
    warnings: p.warnings,
  };
}

/**
 * An asset of the classroom's copy, for the payload `readableClassroom`
 * decided: the staff read any; a student only one a page they may read
 * references (J1) — otherwise null, the 404 of a missing asset.
 */
export async function journalAsset(db: Db, classroomId: string, path: string, payload: ClassroomPayload) {
  if (payload === "student" && !(await studentMayFetch(db, classroomId, path))) return null;
  const [asset] = await db
    .select({
      blobSha: journalAssets.blobSha,
      contentType: journalAssets.contentType,
      data: journalAssets.data,
    })
    .from(journalAssets)
    .where(and(eq(journalAssets.classroomId, classroomId), eq(journalAssets.path, path)));
  return asset ?? null;
}

/**
 * Asks for a classroom's copy to be rebuilt: one `journal.ingest` job. The
 * webhook's push handler calls it, and M4-03's Refresh and saves will.
 * Without a queue (`JOBS_DISABLED=1`, a queue failed at boot) the ingestion
 * runs here, awaited, its failure recorded on the row by the ingestion
 * itself. J2 is the ingestion's compare-and-set, not the queue's.
 */
export async function requestIngest(app: FastifyInstance, config: AppConfig, classroomId: string): Promise<void> {
  if (app.boss) {
    await app.boss.send(JOURNAL_INGEST_QUEUE, { classroomId });
    return;
  }
  await ingestJournal(app, config, classroomId);
}
