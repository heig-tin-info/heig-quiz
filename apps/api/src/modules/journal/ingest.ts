/**
 * Building a classroom's copy of its journal from the repository (spec 05
 * §5.11, 04-journal §4.1; ported from heig-classroom's `journal/ingest.ts`,
 * sync point `ab98cc0`, one row per classroom since D03).
 *
 * Runs from the `journal.ingest` queue (a push, M4-03's Refresh and the
 * re-ingestion after a browser save) — never on a page view. Idempotent:
 * replayed on the same commit it rewrites the same rows.
 *
 * **No lock is held while GitHub is read (fix J2, N-RES-07).** An ingestion
 * is optimistic, in three steps:
 *  1. a SNAPSHOT of the classroom's row (its `version`), of the stored
 *     pages' blob shas and markdown and of the cached assets' shas;
 *  2. the FETCH, outside any transaction: the head, the tree, the blobs that
 *     moved, every page rendered — GitHub calls all bounded (`repo.ts`);
 *  3. ONE short transaction that locks the row (`SELECT … FOR UPDATE`) and
 *     writes the copy only if its `version` is still the snapshot's, bumping
 *     it. A failure is written the same way, by a compare-and-set of its own.
 * Every other writer of the row bumps `version` too (a rename, a deletion,
 * another ingestion), so a result built from a stale snapshot is never
 * committed: the ingestion runs once more from a fresh snapshot, and if it
 * loses again, re-sends its job (or, without a queue, says so).
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

import {
  assetContentType,
  isJournalPagePath,
  JOURNAL_ASSET_MAX_BYTES,
  safeJournalPath,
  type JournalSyncError,
} from "@quiz/contracts";
import { cleanSource, placePage } from "@quiz/docrender";

import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import {
  classroomJournals,
  githubClassroomLinks,
  githubOrganizations,
  journalAssets,
  journalPages,
} from "../../db/schema.js";
import { JOURNAL_INGEST_QUEUE } from "../../jobs.js";
import { redactTokens } from "../../redact.js";
import { actsOn } from "../github/service.js";
import { journalChanged } from "./events.js";
import {
  boundedClient,
  JournalRepoError,
  readBlob,
  readTree,
  resolveRepo,
  syncErrorOf,
  type TreeEntry,
} from "./repo.js";
import { githubJournal, type GithubJournal } from "./mode.js";
import { renderSources, renderStudentPages, storePages, type PageSource, type RenderedRow } from "./rendering.js";

export type IngestOutcome =
  | { status: "ok"; commitSha: string | null; pages: number; assets: number }
  | { status: "error"; code: JournalSyncError }
  /** Another writer moved the row twice under this ingestion: its job was sent again. */
  | { status: "superseded" };

/** Runs of one ingestion before it hands over to a new job: the first, and one more. */
const ATTEMPTS = 2;

// ---------------------------------------------------------------- 1. the snapshot

interface Snapshot {
  row: GithubJournal;
  /** Null: the organization is not installed, or not active. */
  installationId: number | null;
  pages: Map<string, { id: string; blobSha: string; markdown: string }>;
  assets: Map<string, string>;
}

/** Null when the classroom has no journal, or a Quiz-mode one: there is no repository to copy (ADR-057). */
async function snapshot(db: Db, classroomId: string): Promise<Snapshot | null> {
  const [target] = await db
    .select({
      row: classroomJournals,
      installationId: githubOrganizations.installationId,
      orgStatus: githubOrganizations.status,
      suspendedAt: githubOrganizations.suspendedAt,
    })
    .from(classroomJournals)
    .leftJoin(githubClassroomLinks, eq(githubClassroomLinks.classroomId, classroomJournals.classroomId))
    .leftJoin(githubOrganizations, eq(githubOrganizations.id, githubClassroomLinks.orgId))
    .where(eq(classroomJournals.classroomId, classroomId));
  if (!target) return null;
  const row = githubJournal(target.row);
  if (!row) return null;
  const [pages, assets] = await Promise.all([
    db
      .select({ id: journalPages.id, path: journalPages.path, blobSha: journalPages.blobSha, markdown: journalPages.markdown })
      .from(journalPages)
      .where(eq(journalPages.classroomId, classroomId)),
    db
      .select({ path: journalAssets.path, blobSha: journalAssets.blobSha })
      .from(journalAssets)
      .where(eq(journalAssets.classroomId, classroomId)),
  ]);
  return {
    row,
    // The one rule of an organization the App acts on (`actsOn`, `modules/github/service.ts`).
    installationId: actsOn({ installationId: target.installationId, suspendedAt: target.suspendedAt, status: target.orgStatus })
      ? target.installationId
      : null,
    pages: new Map(pages.map((p) => [p.path, p])),
    assets: new Map(assets.map((a) => [a.path, a.blobSha])),
  };
}

// ---------------------------------------------------------------- 2. the fetch

/** What the transaction writes: everything already read and rendered. */
interface Copy {
  fullName: string;
  commitSha: string | null;
  pages: RenderedRow[];
  /** The assets whose blob moved, downloaded. */
  downloads: { path: string; blobSha: string; data: Buffer }[];
  /** Every asset a page references: the ones kept. */
  referenced: string[];
}

/**
 * The files under the journal's root that may be served as assets, by
 * journal-relative path, and the ones too large to (a reference to one says
 * so). Not a page, and a path the
 * routes would accept (`safeJournalPath`, N-SEC-15).
 */
function classifyAssets(entries: readonly TreeEntry[], root: string) {
  const prefix = root ? `${root}/` : "";
  const assets = new Map<string, TreeEntry>();
  const oversized = new Set<string>();
  for (const entry of entries) {
    if (isJournalPagePath(entry.path) || !entry.path.startsWith(prefix)) continue;
    const path = entry.path.slice(prefix.length);
    // Repository furniture (a `.`-segment, `.github/`) fails it too.
    if (safeJournalPath(path) === null) continue;
    if (entry.size > JOURNAL_ASSET_MAX_BYTES) oversized.add(path);
    else assets.set(path, entry);
  }
  return { assets, oversized };
}

/** GitHub read and every page rendered, with no database access at all. */
async function fetchCopy(config: AppConfig, snap: Snapshot): Promise<Copy> {
  if (snap.installationId === null) {
    throw new JournalRepoError("forbidden", "the classroom's organization has no installation");
  }
  const octokit = await boundedClient(config, snap.installationId);
  const repo = await resolveRepo(octokit, snap.row.githubRepoId);
  let tree: Awaited<ReturnType<typeof readTree>> | null;
  try {
    tree = await readTree(octokit, repo, snap.row.ref);
  } catch (err) {
    // A repository with no commit has no pages: the honest copy is empty.
    if (!(err instanceof JournalRepoError && err.code === "empty")) throw err;
    tree = null;
  }
  const root = snap.row.rootPath.replace(/^\/+|\/+$/g, "");
  const entries = tree?.entries ?? [];
  if (tree && root && !entries.some((e) => e.path.startsWith(`${root}/`))) {
    throw new JournalRepoError("root_not_found", `${repo.fullName} has no folder ${root}`);
  }
  const { assets, oversized } = classifyAssets(entries, root);
  // A page over the size cap is not copied, like an asset: a link to it is a missing target.
  const placed = entries.flatMap((entry) => {
    const place = entry.size > JOURNAL_ASSET_MAX_BYTES ? null : placePage(entry.path, root);
    return place ? [{ entry, place }] : [];
  });
  const blob = (sha: string) => readBlob(octokit, repo, sha);

  const sources: PageSource[] = [];
  for (const { entry, place } of placed) {
    const before = snap.pages.get(place.path);
    const moved = before?.blobSha !== entry.sha;
    const markdown = moved ? cleanSource((await blob(entry.sha)).toString("utf8")) : before!.markdown;
    sources.push({ id: before?.id ?? randomUUID(), path: place.path, markdown, blobSha: entry.sha, moved });
  }
  const { pages, referenced } = renderSources(snap.row.classroomId, sources, new Set(assets.keys()), oversized);

  const downloads: Copy["downloads"] = [];
  for (const path of referenced) {
    const entry = assets.get(path)!;
    if (snap.assets.get(path) === entry.sha) continue;
    const data = await blob(entry.sha);
    if (data.length <= JOURNAL_ASSET_MAX_BYTES) downloads.push({ path, blobSha: entry.sha, data });
  }
  return {
    fullName: repo.fullName,
    commitSha: tree?.commitSha ?? null,
    pages,
    downloads,
    referenced: [...referenced],
  };
}

// ---------------------------------------------------------------- 3. the write

/**
 * The row locked, and `true` if its `version` is still `expected`: the
 * compare half of every compare-and-set of this module.
 */
async function lockedAt(tx: Tx, classroomId: string, expected: number): Promise<boolean> {
  const [row] = await tx
    .select({ version: classroomJournals.version })
    .from(classroomJournals)
    .where(eq(classroomJournals.classroomId, classroomId))
    .for("update");
  return row?.version === expected;
}

const bumped = () => sql`${classroomJournals.version} + 1`;

/**
 * The platform wrote to the repository or changed the row outside an
 * ingestion (M4-11's Move to GitHub, a mode switch): the row's `version`
 * moves, so an ingestion that read GitHub before it loses its
 * compare-and-set and starts over from a fresh snapshot (J2).
 */
export async function bumpVersion(db: Db, classroomId: string): Promise<void> {
  await db.update(classroomJournals).set({ version: bumped() }).where(eq(classroomJournals.classroomId, classroomId));
}

/** The copy written in one short transaction, or false when the row moved since the snapshot. */
async function commitCopy(db: Db, snap: Snapshot, copy: Copy, now: Date): Promise<boolean> {
  const classroomId = snap.row.classroomId;
  return db.transaction(async (tx) => {
    if (!(await lockedAt(tx, classroomId, snap.row.version))) return false;
    await storePages(tx, classroomId, copy.pages, now);
    for (const { path, blobSha, data } of copy.downloads) {
      const values = { blobSha, contentType: assetContentType(path), size: data.length, data, updatedAt: now };
      await tx
        .insert(journalAssets)
        .values({ id: randomUUID(), classroomId, path, ...values })
        .onConflictDoUpdate({ target: [journalAssets.classroomId, journalAssets.path], set: values });
    }
    await tx
      .delete(journalAssets)
      .where(
        copy.referenced.length
          ? and(eq(journalAssets.classroomId, classroomId), notInArray(journalAssets.path, copy.referenced))
          : eq(journalAssets.classroomId, classroomId),
      );
    await renderStudentPages(tx, classroomId);
    await tx
      .update(classroomJournals)
      .set({
        fullName: copy.fullName,
        lastCommitSha: copy.commitSha,
        lastSyncedAt: now,
        syncStatus: "ok",
        syncError: null,
        updatedAt: now,
        version: bumped(),
      })
      .where(eq(classroomJournals.classroomId, classroomId));
    return true;
  });
}

/** A failure recorded by its own compare-and-set, the pages kept; false when the row moved. */
async function commitFailure(db: Db, snap: Snapshot, code: JournalSyncError, now: Date): Promise<boolean> {
  const updated = await db
    .update(classroomJournals)
    .set({ syncStatus: "error", syncError: code, lastSyncedAt: now, updatedAt: now, version: bumped() })
    .where(
      and(
        eq(classroomJournals.classroomId, snap.row.classroomId),
        eq(classroomJournals.version, snap.row.version),
      ),
    )
    .returning({ classroomId: classroomJournals.classroomId });
  return updated.length > 0;
}

// ---------------------------------------------------------------- the ingestion

/**
 * Rebuilds one classroom's copy. Returns null when the classroom has no
 * journal (removed since the job was sent) or a Quiz-mode one, which has no
 * repository and is never ingested (ADR-057). A failure GitHub answered, or
 * GitHub not answering in time, is recorded on the row (`sync_status =
 * error`, the code) and RETURNED, the pages kept; the queue's worker decides
 * what is worth a retry. A database failure is thrown.
 */
export async function ingestJournal(
  app: FastifyInstance,
  config: AppConfig,
  classroomId: string,
): Promise<IngestOutcome | null> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const snap = await snapshot(app.db, classroomId);
    if (!snap) return null;
    let copy: Copy | null = null;
    let code: JournalSyncError | null = null;
    try {
      copy = await fetchCopy(config, snap);
    } catch (err) {
      code = syncErrorOf(err);
      app.log.warn(
        { classroomId, code, error: redactTokens(String((err as Error)?.message ?? err)) },
        "journal synchronisation failed",
      );
    }
    const now = app.clock.now();
    const written = copy ? await commitCopy(app.db, snap, copy, now) : await commitFailure(app.db, snap, code!, now);
    if (!written) continue; // the row moved under us: from a fresh snapshot
    journalChanged([classroomId]);
    return copy
      ? { status: "ok", commitSha: copy.commitSha, pages: copy.pages.length, assets: copy.referenced.length }
      : { status: "error", code: code! };
  }
  // Lost every time: a later job starts over, after whatever keeps moving the row.
  await app.boss?.send(JOURNAL_INGEST_QUEUE, { classroomId });
  return { status: "superseded" };
}

// ---------------------------------------------------------------- the student rendering

/**
 * Fix J4: the journals holding a page whose `visible_from` passed since
 * their students' pages were last rendered get them rendered again (the
 * links to the newly visible page appear) and their readers a `journal`
 * hint, so the page shows up without a reload (F-JRN-08). Run by the
 * ticker every minute (`jobs.ts`). The row is locked briefly, `SKIP
 * LOCKED`: a journal an ingestion is writing is skipped, that ingestion
 * renders it. No `version` bump: an ingestion in flight re-renders every
 * student page when it writes. Returns the classrooms re-rendered.
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
      const [row] = await tx
        .select({ id: classroomJournals.classroomId })
        .from(classroomJournals)
        .where(eq(classroomJournals.classroomId, classroomId))
        .for("update", { skipLocked: true });
      if (!row) return false;
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
 * while the staff find out). Every row holding the repository, in one
 * statement that bumps `version`, so an ingestion in flight does not commit
 * over it. Returns the classrooms touched.
 */
export async function repositoryChanged(
  app: FastifyInstance,
  githubRepoId: number,
  change: { action: "renamed"; fullName: string } | { action: "deleted" },
): Promise<string[]> {
  const now = app.clock.now();
  const touched = await app.db
    .update(classroomJournals)
    .set({
      ...(change.action === "renamed"
        ? { fullName: change.fullName }
        : { syncStatus: "error" as const, syncError: "repo_not_found" as const, lastSyncedAt: now }),
      updatedAt: now,
      version: bumped(),
    })
    // A repository id matches GitHub-mode rows only (`classroom_journals_mode_ck`).
    .where(eq(classroomJournals.githubRepoId, githubRepoId))
    .returning({ classroomId: classroomJournals.classroomId });
  const ids = touched.map((r) => r.classroomId);
  journalChanged(ids);
  return ids;
}
