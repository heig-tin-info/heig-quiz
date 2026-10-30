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
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import type { ClassroomJournalSignal, JournalPageStaff, JournalRepository, JournalStaff } from "@quiz/contracts";
import { buildNav, homePage, journalRepoName } from "@quiz/docrender";
import { confirmsName } from "@quiz/domain";

import { isoOrNull } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { classroomJournals, journalAssets, journalPages } from "../../db/schema.js";
import { JOURNAL_INGEST_QUEUE } from "../../jobs.js";
import type { ClassroomPayload } from "../guards.js";
import { JournalError } from "./errors.js";
import { ingestJournal } from "./ingest.js";
import { editUrl, githubJournal, repoUrl, type GithubJournal, type JournalRow } from "./mode.js";
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

/**
 * Where each classroom's journal stands for its students (#805), for the
 * staff's classroom rows (`listCourses`): the page that most recently
 * became visible to them and the next one a `visible_from` will show. ONE
 * grouped query for every classroom listed. "Visible" is THE predicate of
 * the student view ({@link visibleToStudents}: not a draft, `visible_from`
 * passed on the database's clock); "next" is a page that is not a draft
 * with a `visible_from` still ahead of that clock. A page became visible at
 * the later of its `visible_from` and its creation — an approximation: a
 * Quiz-mode page created as a draft and un-drafted later reads as visible
 * since its creation, as no column records the un-drafting (an edit's
 * `updated_at` would make a typo fix the "last page"). The same in both modes
 * (ADR-057). Staff only: no student payload carries it. A classroom
 * without a journal is absent from the map.
 */
export async function journalSignals(db: Db, classroomIds: string[]): Promise<Map<string, ClassroomJournalSignal>> {
  if (classroomIds.length === 0) return new Map();
  // No page (the left join's null row): `draft = false` is null, so it is filtered out.
  const visible = visibleToStudents();
  const scheduled = sql`${journalPages.draft} = false AND ${journalPages.visibleFrom} > now()`;
  const shownAt = sql`greatest(${journalPages.visibleFrom}, ${journalPages.createdAt})`;
  const name = sql`coalesce(${journalPages.title}, ${journalPages.path})`;
  const rows = await db
    .select({
      classroomId: classroomJournals.classroomId,
      lastTitle: sql<string | null>`(array_agg(${name} ORDER BY ${shownAt} DESC, ${journalPages.path}) FILTER (WHERE ${visible}))[1]`,
      lastAt: sql<Date | null>`max(${shownAt}) FILTER (WHERE ${visible})`.mapWith(journalPages.visibleFrom),
      nextTitle: sql<string | null>`(array_agg(${name} ORDER BY ${journalPages.visibleFrom}, ${journalPages.path}) FILTER (WHERE ${scheduled}))[1]`,
      nextAt: sql<Date | null>`min(${journalPages.visibleFrom}) FILTER (WHERE ${scheduled})`.mapWith(journalPages.visibleFrom),
    })
    .from(classroomJournals)
    .leftJoin(journalPages, eq(journalPages.classroomId, classroomJournals.classroomId))
    .where(inArray(classroomJournals.classroomId, classroomIds))
    .groupBy(classroomJournals.classroomId);
  const mark = (title: string | null, at: Date | null) => {
    const iso = isoOrNull(at);
    return title === null || iso === null ? null : { title, at: iso };
  };
  return new Map(
    rows.map((r) => [r.classroomId, { lastPage: mark(r.lastTitle, r.lastAt), nextPage: mark(r.nextTitle, r.nextAt) }]),
  );
}

function repositoryView(row: GithubJournal): JournalRepository {
  return {
    fullName: row.fullName,
    ref: row.ref,
    rootPath: row.rootPath,
    htmlUrl: repoUrl(row),
    syncStatus: row.syncStatus,
    syncError: row.syncError,
    lastSyncedAt: isoOrNull(row.lastSyncedAt),
    lastCommitSha: row.lastCommitSha,
  };
}

/**
 * `GET /classrooms/:id/journal` for the staff: every page, what students do
 * not see, the sync state, and every file with its last change.
 */
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
      files: [],
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
      updatedAt: journalPages.updatedAt,
    })
    .from(journalPages)
    .where(eq(journalPages.classroomId, room.id));
  const assets = await db
    .select({ path: journalAssets.path, updatedAt: journalAssets.updatedAt })
    .from(journalAssets)
    .where(eq(journalAssets.classroomId, room.id));
  const files = [
    ...pages.map((p) => ({ path: p.path, kind: "page" as const, updatedAt: p.updatedAt.toISOString() })),
    ...assets.map((a) => ({ path: a.path, kind: "asset" as const, updatedAt: a.updatedAt.toISOString() })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
    files,
    proposedName: null,
  };
}

/**
 * `GET /classrooms/:id/journal/pages/*` for the staff: the page, its source,
 * its lock, and in GitHub mode where to edit it.
 */
export async function staffPage(db: Db | Tx, classroomId: string, path: string): Promise<JournalPageStaff | null> {
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
 * The one guard of F-JRN-04 (ADR-057): a Quiz-mode journal holding pages is
 * the only copy of them, and goes — by its removal, or by its classroom's
 * deletion (F-ORG-09, `org`'s route) — only with the classroom's name typed
 * as `confirm`: 409 `confirm_required` otherwise. A GitHub-mode journal (the
 * repository stays) or an empty one needs nothing. Returns the journal's
 * page count (0 with no journal), what the removal audits.
 */
export async function journalRemovalRefused(
  db: Db | Tx,
  room: { id: string; name: string },
  confirm: string | undefined,
): Promise<number> {
  const [row] = await db
    .select({ mode: classroomJournals.mode, pages: count(journalPages.id) })
    .from(classroomJournals)
    .leftJoin(journalPages, eq(journalPages.classroomId, classroomJournals.classroomId))
    .where(eq(classroomJournals.classroomId, room.id))
    .groupBy(classroomJournals.mode);
  const pages = row?.pages ?? 0;
  if (row?.mode === "quiz" && pages > 0 && !confirmsName(confirm ?? "", room.name)) {
    throw new JournalError("confirm_required");
  }
  return pages;
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
