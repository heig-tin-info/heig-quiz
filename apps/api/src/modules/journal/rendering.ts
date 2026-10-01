/**
 * A journal's pages rendered from their sources, the same way in both modes
 * (ADR-057): the GitHub ingestion renders the files it fetched (`ingest.ts`),
 * a Quiz-mode write renders the pages the database holds (`quiz.ts`). One
 * code path, so a Quiz-mode journal reads exactly as an ingestion of the same
 * files would — titles, navigation, links between pages, warnings, the assets
 * each page references (J1) and the student rendering (N-SEC-12).
 *
 * Every page is rendered with all the others in view: a page's HTML depends
 * on its neighbours (a link to a page that appeared must become a link), so a
 * write of one page renders the whole journal again. Journals are small.
 */
import { and, eq, notInArray, sql } from "drizzle-orm";

import { navSortKey, parentOf, prettifyName, renderPage, type RenderedPage } from "@quiz/docrender";

import type { Tx } from "../../db/client.js";
import { classroomJournals, journalPages } from "../../db/schema.js";
import { visibleToStudents } from "./studentView.js";

/**
 * One page of a classroom's journal rendered at `path`, its file name the
 * title of last resort, with `pages` linkable and `assets` served: every
 * rendering of the module goes through here.
 */
export function renderAt(
  classroomId: string,
  path: string,
  markdown: string,
  pages: ReadonlySet<string>,
  assets: ReadonlySet<string>,
  oversized?: ReadonlySet<string>,
): RenderedPage {
  return renderPage(markdown, {
    classroomId,
    pagePath: path,
    fallbackTitle: prettifyName(path),
    pages,
    assets,
    ...(oversized ? { oversized } : {}),
  });
}

/** A page's source, as stored or as fetched. */
export interface PageSource {
  id: string;
  path: string;
  markdown: string;
  blobSha: string;
  /** Its source changed in this write: its `updated_at` moves (a neighbour's change is no change of it). */
  moved: boolean;
}

export type RenderedRow = typeof journalPages.$inferInsert & { moved: boolean };

/**
 * Every page of a journal rendered for the staff, with every page linkable
 * and the `assets` the platform serves (`oversized`: files too large to,
 * which a reference names as such). `referenced`: the assets some page
 * references. The student rendering is {@link renderStudentPages}', once the
 * rows are stored, on the database's clock.
 */
export function renderSources(
  classroomId: string,
  sources: readonly PageSource[],
  assets: ReadonlySet<string>,
  oversized?: ReadonlySet<string>,
): { pages: RenderedRow[]; referenced: Set<string> } {
  const pagePaths = new Set(sources.map((s) => s.path));
  const referenced = new Set<string>();
  const pages = sources.map(({ id, path, markdown, blobSha, moved }): RenderedRow => {
    const page = renderAt(classroomId, path, markdown, pagePaths, assets, oversized);
    for (const asset of page.assets) referenced.add(asset);
    return {
      id,
      classroomId,
      path,
      parentPath: parentOf(path),
      sortKey: navSortKey(path),
      title: page.title,
      frontMatter: page.frontMatter,
      blobSha,
      markdown,
      htmlStaff: page.html,
      htmlStudent: "",
      toc: page.toc,
      draft: page.draft,
      visibleFrom: page.visibleFrom,
      warnings: page.warnings,
      assetPaths: page.assets,
      moved,
    };
  });
  return { pages, referenced };
}

/**
 * The rendered pages written, by path, and every other page of the journal
 * deleted. A page's `version` (Quiz mode's lock) is never touched here: the
 * write that changed its source bumps it.
 */
export async function storePages(tx: Tx, classroomId: string, pages: readonly RenderedRow[], now: Date): Promise<void> {
  for (const { moved, ...page } of pages) {
    const { id: _id, classroomId: _c, path: _p, htmlStudent: _h, ...values } = page;
    const set = moved ? { ...values, updatedAt: now } : values;
    await tx
      .insert(journalPages)
      .values({ ...page, updatedAt: now })
      .onConflictDoUpdate({ target: [journalPages.classroomId, journalPages.path], set });
  }
  const kept = pages.map((p) => p.path);
  await tx
    .delete(journalPages)
    .where(
      kept.length
        ? and(eq(journalPages.classroomId, classroomId), notInArray(journalPages.path, kept))
        : eq(journalPages.classroomId, classroomId),
    );
}

/**
 * Renders again the `html_student` of every page of a classroom's journal,
 * from the stored markdown — no GitHub call — with only the pages
 * {@link visibleToStudents} holds for linkable NOW (the database's clock),
 * and stamps the row with that `now()`. The assets are the ones the pages
 * reference (their `asset_paths`, which the staff rendering resolved): the
 * same links as for the staff. Called with the row locked: by an ingestion,
 * a Quiz-mode write, and the J4 sweep.
 */
export async function renderStudentPages(tx: Tx, classroomId: string): Promise<void> {
  const pages = await tx
    .select({
      id: journalPages.id,
      path: journalPages.path,
      markdown: journalPages.markdown,
      assetPaths: journalPages.assetPaths,
      visible: sql<boolean>`${visibleToStudents()}`,
    })
    .from(journalPages)
    .where(eq(journalPages.classroomId, classroomId));
  const visible = new Set(pages.filter((p) => p.visible).map((p) => p.path));
  const assets = new Set(pages.flatMap((p) => p.assetPaths));
  for (const page of pages) {
    const { html } = renderAt(classroomId, page.path, page.markdown, visible, assets);
    await tx.update(journalPages).set({ htmlStudent: html }).where(eq(journalPages.id, page.id));
  }
  await tx
    .update(classroomJournals)
    .set({ studentRenderedAt: sql`now()` })
    .where(eq(classroomJournals.classroomId, classroomId));
}
