/**
 * The `journal` module (ADR-049 and its addendum, spec 05 §5.11,
 * docs/merge/04-journal.md, ADR-057): a classroom's course documentation,
 * held in Quiz itself or in a GitHub repository copied in, in
 * `classroom_journals`, `journal_pages`, `journal_assets` and
 * `journal_page_revisions`, which this module alone writes.
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
import { editUrl, githubJournal, type GithubJournal, type JournalRow } from "./mode.js";
import { studentMayFetch, visibleToStudents } from "./studentView.js";

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

function repositoryView(row: GithubJournal): JournalRepository {
  return {
    fullName: row.fullName,
    ref: row.ref,
    rootPath: row.rootPath,
    htmlUrl: `https://github.com/${row.fullName}`,
    syncStatus: row.syncStatus,
    syncError: row.syncError,
    lastSyncedAt: isoOrNull(row.lastSyncedAt),
    lastCommitSha: row.lastCommitSha,
    // Read-only in the platform (ADR-057): edited on GitHub, `editUrl` of a page.
    editable: false,
  };
}

/** `GET /classrooms/:id/journal` for the staff: every page, what students do not see, the sync state. */
export async function staffJournal(db: Db, room: { id: string; name: string }): Promise<JournalStaff> {
  const row = await journalRow(db, room.id);
  if (!row) {
    return {
      view: "staff",
      mode: null,
      repository: null,
      nav: [],
      homePath: null,
      hiddenPaths: [],
      warningCount: 0,
      pageCount: 0,
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
  const github = githubJournal(row);
  return {
    view: "staff",
    mode: row.mode,
    repository: github ? repositoryView(github) : null,
    nav: buildNav(pages),
    homePath: homePage(pages)?.path ?? null,
    hiddenPaths: pages.filter((p) => p.hidden).map((p) => p.path).sort(),
    warningCount: pages.filter((p) => p.warned).length,
    pageCount: pages.length,
    proposedName: null,
  };
}

/**
 * `GET /classrooms/:id/journal/pages/*` for the staff: the page, its source,
 * its lock, and in GitHub mode where to edit it.
 */
export async function staffPage(db: Db, classroomId: string, path: string): Promise<JournalPageStaff | null> {
  const [page] = await db
    .select({ page: journalPages, journal: classroomJournals, hidden: hiddenFromStudents() })
    .from(journalPages)
    .innerJoin(classroomJournals, eq(classroomJournals.classroomId, journalPages.classroomId))
    .where(and(eq(journalPages.classroomId, classroomId), eq(journalPages.path, path)));
  if (!page) return null;
  const p = page.page;
  const github = githubJournal(page.journal);
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
    version: p.version,
    warnings: p.warnings,
    editUrl: github ? editUrl(github, p.path) : null,
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
 * webhook's push handler calls it, and so do the Refresh and the choice of a
 * repository (M4-03). Without a
 * queue (`JOBS_DISABLED=1`, a queue failed at boot) the ingestion runs here,
 * awaited, its failure recorded on the row by the ingestion itself. J2 is the
 * ingestion's compare-and-set, not the queue's.
 */
export async function requestIngest(app: FastifyInstance, config: AppConfig, classroomId: string): Promise<void> {
  if (app.boss) {
    await app.boss.send(JOURNAL_INGEST_QUEUE, { classroomId });
    return;
  }
  await ingestJournal(app, config, classroomId);
}
