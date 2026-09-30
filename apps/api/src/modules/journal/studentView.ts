/**
 * THE journal's one exit towards a student (invariant 4, N-SEC-12, N-SEC-13,
 * spec 05 §5.7), like `toStudent` for questions: every student payload of
 * the journal's routes is built here and nowhere else, whoever the student
 * caller is — a claimed seat, a teacher in the student view, an
 * impersonation session (`readableClassroom` decided that).
 *
 * - Which pages a student reads is ONE predicate, {@link visibleToStudents}:
 *   not a draft, `visible_from` null or passed on the DATABASE's clock. The
 *   ingestion and the J4 sweep render `html_student` by it too.
 * - A payload is built from the columns a student may read only (never the
 *   markdown, the blob sha, the warnings, the front matter, the draft flag,
 *   the date, a count of what is hidden), then parsed by the STRICT student
 *   schema of the contracts, which refuses any other key.
 * - The HTML is `html_student`, in which a link to a hidden page is text.
 * - An asset is served only when a page of that payload references it
 *   (fix J1): otherwise the 404 of a missing one.
 */
import { and, arrayContains, eq, isNull, lte, or, sql, type SQL } from "drizzle-orm";

import { JournalPageStudent, JournalStudent } from "@quiz/contracts";
import { buildNav, homePage } from "@quiz/docrender";

import type { Db } from "../../db/client.js";
import { journalPages } from "../../db/schema.js";

/** A page a student may read: published, and past its `visible_from` (the database's `now()`). */
export function visibleToStudents(): SQL {
  return and(
    eq(journalPages.draft, false),
    or(isNull(journalPages.visibleFrom), lte(journalPages.visibleFrom, sql`now()`)),
  )!;
}

/** `GET /classrooms/:id/journal`, student payload, for a classroom the route found holding a journal. */
export async function studentJournal(db: Db, classroomId: string): Promise<JournalStudent> {
  const pages = await db
    .select({
      path: journalPages.path,
      parentPath: journalPages.parentPath,
      sortKey: journalPages.sortKey,
      title: journalPages.title,
    })
    .from(journalPages)
    .where(and(eq(journalPages.classroomId, classroomId), visibleToStudents()));
  return JournalStudent.parse({
    view: "student",
    nav: buildNav(pages),
    homePath: homePage(pages)?.path ?? null,
  });
}

/** `GET /classrooms/:id/journal/pages/*`, student payload; null (a 404) for a page a student may not read. */
export async function studentPage(
  db: Db,
  classroomId: string,
  path: string,
): Promise<JournalPageStudent | null> {
  const [page] = await db
    .select({
      path: journalPages.path,
      title: journalPages.title,
      html: journalPages.htmlStudent,
      toc: journalPages.toc,
      updatedAt: journalPages.updatedAt,
    })
    .from(journalPages)
    .where(
      and(eq(journalPages.classroomId, classroomId), eq(journalPages.path, path), visibleToStudents()),
    );
  if (!page) return null;
  return JournalPageStudent.parse({ view: "student", ...page, updatedAt: page.updatedAt.toISOString() });
}

/** Whether a page students may read references the asset at `path` (fix J1, N-SEC-13). */
export async function studentMayFetch(db: Db, classroomId: string, path: string): Promise<boolean> {
  const [page] = await db
    .select({ id: journalPages.id })
    .from(journalPages)
    .where(
      and(
        eq(journalPages.classroomId, classroomId),
        arrayContains(journalPages.assetPaths, [path]),
        visibleToStudents(),
      ),
    )
    .limit(1);
  return page !== undefined;
}
