/**
 * Building a classroom's copy of its journal from the repository (spec 05
 * §5.11, 04-journal §4.1; ported from heig-classroom's `journal/ingest.ts`,
 * sync point `ab98cc0`, one row per classroom since D03).
 *
 * Runs from the `journal.ingest` queue (a push, M4-03's Refresh and the
 * re-ingestion after a browser save) — never on a page view. Idempotent:
 * replayed on the same commit it rewrites the same rows.
 *
 * **Serialised per classroom (fix J2, N-RES-07).** An ingestion is one
 * transaction that first takes a transaction-scoped advisory lock on the
 * classroom's row, then reads the head, the tree and the blobs that moved,
 * and writes the whole copy. Two ingestions of one classroom therefore
 * never interleave, whoever sends them (the queue, a test, a direct call),
 * and the later one reads a head at least as new as the earlier's: they
 * converge on the repository's state. The GitHub reads happen inside the
 * transaction on purpose: taken outside it, a slow ingestion of an old head
 * could commit after a fast one of the new head and win. A failure is
 * written under the same lock (the copy's own work runs in a savepoint), so
 * a late error never overwrites a newer success.
 *
 * Four decisions carry the cost (classroom's, kept):
 *  1. a blob is fetched only when its sha moved — the tree gives every sha;
 *  2. every page is re-rendered anyway, from the stored markdown: a page's
 *     HTML depends on its neighbours (a link to yesterday's missing page
 *     must become a link today);
 *  3. only the assets a page references are downloaded (D14);
 *  4. each page is rendered TWICE (M4-01): `html_staff` with every page
 *     linkable, `html_student` with only the pages students may read, so a
 *     draft's or a future page's path never reaches a student (N-SEC-12).
 *     Which pages those are is decided by ONE predicate,
 *     {@link visibleToStudents}, on the database's clock — the same the
 *     student routes read with and the J4 sweep re-renders by.
 */
import { randomUUID } from "node:crypto";

import { and, eq, gt, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { isJournalPagePath, JOURNAL_ASSET_MAX_BYTES, safeJournalPath, type JournalSyncError } from "@quiz/contracts";
import { assetContentType, cleanSource, placePage, prettifyName, renderPage } from "@quiz/docrender";

import type { AppConfig } from "../../config.js";
import type { Tx } from "../../db/client.js";
import {
  classroomJournals,
  githubClassroomLinks,
  githubOrganizations,
  journalAssets,
  journalPages,
} from "../../db/schema.js";
import { installationClient } from "../../github/app.js";
import { redactTokens } from "../../redact.js";
import { journalChanged } from "./events.js";
import { JournalRepoError, readBlob, readTree, resolveRepo, syncErrorOf, type TreeEntry } from "./repo.js";
import { visibleToStudents } from "./studentView.js";

export type IngestOutcome =
  | { status: "ok"; commitSha: string | null; pages: number; assets: number }
  | { status: "error"; code: JournalSyncError };

// ---------------------------------------------------------------- the lock

/**
 * The per-classroom lock of fix J2, held until the transaction ends. With
 * `wait: false` it is only tried: the J4 sweep skips a journal an ingestion
 * holds (that ingestion renders the students' pages itself).
 */
async function lockJournal(tx: Tx, classroomId: string, { wait = true } = {}): Promise<boolean> {
  const key = sql`hashtextextended(${`journal:${classroomId}`}, 0)`;
  if (wait) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${key})`);
    return true;
  }
  const result = (await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${key}) AS locked`)) as unknown as {
    rows: { locked: boolean }[];
  };
  return result.rows[0]?.locked === true;
}

// ---------------------------------------------------------------- the ingestion

/**
 * Rebuilds one classroom's copy. Returns null when the classroom has no
 * journal (removed since the job was sent). A failure GitHub answered is
 * recorded on the row (`sync_status = error`, the code) and RETURNED, the
 * pages kept; the queue's worker decides what is worth a retry. Anything
 * else (a database failure) is thrown, the row untouched.
 */
export async function ingestJournal(
  app: FastifyInstance,
  config: AppConfig,
  classroomId: string,
): Promise<IngestOutcome | null> {
  const outcome = await app.db.transaction(async (tx) => {
    await lockJournal(tx, classroomId);
    const [target] = await tx
      .select({
        row: classroomJournals,
        installationId: githubOrganizations.installationId,
        orgStatus: githubOrganizations.status,
      })
      .from(classroomJournals)
      .leftJoin(githubClassroomLinks, eq(githubClassroomLinks.classroomId, classroomJournals.classroomId))
      .leftJoin(githubOrganizations, eq(githubOrganizations.id, githubClassroomLinks.orgId))
      .where(eq(classroomJournals.classroomId, classroomId));
    if (!target) return null;
    const now = app.clock.now();
    try {
      // A savepoint: a failure undoes the copy's half-written rows, never the lock.
      return await tx.transaction(async (inner) => {
        const installationId = target.orgStatus === "active" ? target.installationId : null;
        if (installationId === null) {
          throw new JournalRepoError("forbidden", "the classroom's organization has no installation");
        }
        return await synchronise(inner, config, target.row, installationId, now);
      });
    } catch (err) {
      if (!(err instanceof JournalRepoError) && typeof (err as { status?: unknown }).status !== "number") {
        throw err;
      }
      const code = syncErrorOf(err);
      app.log.warn(
        { classroomId, code, error: redactTokens(String((err as Error).message ?? err)) },
        "journal synchronisation failed",
      );
      await tx
        .update(classroomJournals)
        .set({ syncStatus: "error", syncError: code, lastSyncedAt: now, updatedAt: now })
        .where(eq(classroomJournals.classroomId, classroomId));
      return { status: "error", code } satisfies IngestOutcome;
    }
  });
  if (outcome) journalChanged([classroomId]);
  return outcome;
}

/** An installation's client; GitHub refusing the token is the App's access, not an outage. */
async function clientFor(config: AppConfig, installationId: number) {
  try {
    return (await installationClient(config, installationId)).octokit;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== undefined && status >= 400 && status < 500) {
      throw new JournalRepoError("forbidden", "the installation's token was refused");
    }
    throw err;
  }
}

async function synchronise(
  tx: Tx,
  config: AppConfig,
  row: typeof classroomJournals.$inferSelect,
  installationId: number,
  now: Date,
): Promise<IngestOutcome> {
  const octokit = await clientFor(config, installationId);
  const repo = await resolveRepo(octokit, row.githubRepoId);
  let tree: Awaited<ReturnType<typeof readTree>> | null;
  try {
    tree = await readTree(octokit, repo, row.ref);
  } catch (err) {
    // A repository with no commit has no pages: the honest copy is empty.
    if (!(err instanceof JournalRepoError && err.code === "empty")) throw err;
    tree = null;
  }
  const root = row.rootPath.replace(/^\/+|\/+$/g, "");
  if (tree && root && !tree.entries.some((e) => e.path.startsWith(`${root}/`))) {
    throw new JournalRepoError("root_not_found", `${repo.fullName} has no folder ${root}`);
  }
  const counts = await mirror(tx, row.classroomId, root, tree?.entries ?? [], now, (sha) =>
    readBlob(octokit, repo, sha),
  );
  await renderStudentPages(tx, row.classroomId);
  await tx
    .update(classroomJournals)
    .set({
      fullName: repo.fullName,
      lastCommitSha: tree?.commitSha ?? null,
      lastSyncedAt: now,
      syncStatus: "ok",
      syncError: null,
      updatedAt: now,
    })
    .where(eq(classroomJournals.classroomId, row.classroomId));
  return { status: "ok", commitSha: tree?.commitSha ?? null, ...counts };
}

/**
 * The files under the journal's root that may be served as assets, by
 * journal-relative path, and the ones too large to (a reference to one says
 * so). Not a page, not repository furniture (a `.`-segment), and a path the
 * routes would accept (`safeJournalPath`, N-SEC-15).
 */
function classifyAssets(entries: readonly TreeEntry[], root: string) {
  const prefix = root ? `${root}/` : "";
  const assets = new Map<string, TreeEntry>();
  const oversized = new Set<string>();
  for (const entry of entries) {
    if (isJournalPagePath(entry.path) || !entry.path.startsWith(prefix)) continue;
    const path = entry.path.slice(prefix.length);
    if (safeJournalPath(path) === null || path.split("/").some((p) => p.startsWith("."))) continue;
    if (entry.size > JOURNAL_ASSET_MAX_BYTES) oversized.add(path);
    else assets.set(path, entry);
  }
  return { assets, oversized };
}

/**
 * The copy itself: pages upserted (staff rendering) and removed, referenced
 * assets downloaded when their blob moved, the rest dropped. `html_student`
 * is written by {@link renderStudentPages} right after, from the rows.
 */
async function mirror(
  tx: Tx,
  classroomId: string,
  root: string,
  entries: readonly TreeEntry[],
  now: Date,
  blob: (sha: string) => Promise<Buffer>,
): Promise<{ pages: number; assets: number }> {
  const { assets, oversized } = classifyAssets(entries, root);
  const placed = entries.flatMap((entry) => {
    const place = placePage(entry.path, root);
    return place ? [{ entry, place }] : [];
  });
  const pagePaths = new Set(placed.map((p) => p.place.path));
  const assetPaths = new Set(assets.keys());

  const known = new Map(
    (
      await tx
        .select({ id: journalPages.id, path: journalPages.path, blobSha: journalPages.blobSha, markdown: journalPages.markdown })
        .from(journalPages)
        .where(eq(journalPages.classroomId, classroomId))
    ).map((p) => [p.path, p]),
  );

  const referenced = new Set<string>();
  for (const { entry, place } of placed) {
    const before = known.get(place.path);
    const moved = before?.blobSha !== entry.sha;
    const markdown = moved ? cleanSource((await blob(entry.sha)).toString("utf8")) : before!.markdown;
    const page = renderPage(markdown, {
      classroomId,
      pagePath: place.path,
      fallbackTitle: place.fallbackTitle,
      pages: pagePaths,
      assets: assetPaths,
      oversized,
    });
    for (const path of page.assets) referenced.add(path);
    const values = {
      parentPath: place.parentPath,
      sortKey: place.sortKey,
      title: page.title,
      frontMatter: page.frontMatter,
      blobSha: entry.sha,
      markdown,
      htmlStaff: page.html,
      toc: page.toc,
      draft: page.draft,
      visibleFrom: page.visibleFrom,
      warnings: page.warnings,
      assetPaths: page.assets,
      // Only when the blob moved: a neighbour's change is no change of this page.
      ...(moved ? { updatedAt: now } : {}),
    };
    await tx
      .insert(journalPages)
      .values({ id: before?.id ?? randomUUID(), classroomId, path: place.path, htmlStudent: "", ...values })
      .onConflictDoUpdate({ target: [journalPages.classroomId, journalPages.path], set: values });
  }
  await tx
    .delete(journalPages)
    .where(
      pagePaths.size
        ? and(eq(journalPages.classroomId, classroomId), notInArray(journalPages.path, [...pagePaths]))
        : eq(journalPages.classroomId, classroomId),
    );

  const cached = new Map(
    (
      await tx
        .select({ path: journalAssets.path, blobSha: journalAssets.blobSha })
        .from(journalAssets)
        .where(eq(journalAssets.classroomId, classroomId))
    ).map((a) => [a.path, a.blobSha]),
  );
  for (const path of referenced) {
    const entry = assets.get(path)!;
    if (cached.get(path) === entry.sha) continue;
    const data = await blob(entry.sha);
    if (data.length > JOURNAL_ASSET_MAX_BYTES) continue; // the tree lied about the size
    const values = { blobSha: entry.sha, contentType: assetContentType(path), size: data.length, data, updatedAt: now };
    await tx
      .insert(journalAssets)
      .values({ id: randomUUID(), classroomId, path, ...values })
      .onConflictDoUpdate({ target: [journalAssets.classroomId, journalAssets.path], set: values });
  }
  await tx
    .delete(journalAssets)
    .where(
      referenced.size
        ? and(eq(journalAssets.classroomId, classroomId), notInArray(journalAssets.path, [...referenced]))
        : eq(journalAssets.classroomId, classroomId),
    );
  return { pages: placed.length, assets: referenced.size };
}

// ---------------------------------------------------------------- the student rendering

/**
 * Renders again the `html_student` of every page of a classroom's journal,
 * from the stored markdown — no GitHub call — with only the pages
 * {@link visibleToStudents} holds for linkable NOW (the database's clock),
 * and stamps the row with that `now()`. The assets are the ones the pages
 * reference (their `asset_paths`, which the staff rendering resolved
 * against the repository): the same links as at ingestion.
 */
async function renderStudentPages(tx: Tx, classroomId: string): Promise<void> {
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
    const { html } = renderPage(page.markdown, {
      classroomId,
      pagePath: page.path,
      fallbackTitle: prettifyName(page.path),
      pages: visible,
      assets,
    });
    await tx.update(journalPages).set({ htmlStudent: html }).where(eq(journalPages.id, page.id));
  }
  await tx
    .update(classroomJournals)
    .set({ studentRenderedAt: sql`now()` })
    .where(eq(classroomJournals.classroomId, classroomId));
}

/**
 * Fix J4: the journals holding a page whose `visible_from` passed since
 * their students' pages were last rendered get them rendered again (the
 * links to the newly visible page appear) and their readers a `journal`
 * hint, so the page shows up without a reload (F-JRN-08). Run by the
 * ticker every minute (`jobs.ts`); a journal an ingestion holds is skipped,
 * that ingestion renders it. Returns the classrooms re-rendered.
 */
export async function sweepVisibleFrom(app: FastifyInstance): Promise<string[]> {
  const due = await app.db
    .selectDistinct({ classroomId: journalPages.classroomId })
    .from(journalPages)
    .innerJoin(classroomJournals, eq(classroomJournals.classroomId, journalPages.classroomId))
    .where(
      and(
        // The partial index `journal_pages_visible_from_idx`.
        isNotNull(journalPages.visibleFrom),
        lte(journalPages.visibleFrom, sql`now()`),
        eq(journalPages.draft, false),
        or(
          isNull(classroomJournals.studentRenderedAt),
          gt(journalPages.visibleFrom, classroomJournals.studentRenderedAt),
        ),
      ),
    );
  const rendered: string[] = [];
  for (const { classroomId } of due) {
    const done = await app.db.transaction(async (tx) => {
      if (!(await lockJournal(tx, classroomId, { wait: false }))) return false;
      await renderStudentPages(tx, classroomId);
      return true;
    });
    if (done) rendered.push(classroomId);
  }
  journalChanged(rendered);
  return rendered;
}

// ---------------------------------------------------------------- the repository's own events

/**
 * The repository was renamed (followed: the copy keeps working, and the
 * ingestion also follows it by id) or deleted (`sync_status = error`,
 * `repo_not_found`, the pages kept: the classroom still reads its course
 * while the staff find out). Every row holding the repository, each under
 * its lock so an ingestion in flight cannot overwrite it. Returns the
 * classrooms touched.
 */
export async function repositoryChanged(
  app: FastifyInstance,
  githubRepoId: number,
  change: { action: "renamed"; fullName: string } | { action: "deleted" },
): Promise<string[]> {
  const rows = await app.db
    .select({ classroomId: classroomJournals.classroomId })
    .from(classroomJournals)
    .where(eq(classroomJournals.githubRepoId, githubRepoId));
  const touched: string[] = [];
  for (const { classroomId } of rows) {
    const now = app.clock.now();
    const changed = await app.db.transaction(async (tx) => {
      await lockJournal(tx, classroomId);
      const updated = await tx
        .update(classroomJournals)
        .set(
          change.action === "renamed"
            ? { fullName: change.fullName, updatedAt: now }
            : { syncStatus: "error", syncError: "repo_not_found", lastSyncedAt: now, updatedAt: now },
        )
        .where(
          and(
            eq(classroomJournals.classroomId, classroomId),
            eq(classroomJournals.githubRepoId, githubRepoId),
          ),
        )
        .returning({ classroomId: classroomJournals.classroomId });
      return updated.length > 0;
    });
    if (changed) touched.push(classroomId);
  }
  journalChanged(touched);
  return touched;
}
