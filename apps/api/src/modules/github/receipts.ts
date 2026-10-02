/**
 * The push receipts a deletion takes with it (N-DATA-03, D19): the
 * `github` module's own table, purged for the `project` rows a deletion of
 * a project, a classroom or a course removes. Reached through the module's
 * `service.ts`; kept apart so that the `org` module's deletions import
 * nothing more than the database.
 */
import { sql } from "drizzle-orm";

import type { Db, Tx } from "../../db/client.js";
import { pushReceipts } from "../../db/schema.js";

/** The projects a deletion takes with it: one project, a classroom's, or a course's. */
export type ProjectsGone = { projectId: string } | { classroomId: string } | { courseId: string };

/**
 * The push receipts of the projects a deletion takes with it (N-DATA-03,
 * D19, F-PROJ-16, F-ORG-09): those of their students' (and groups')
 * repositories and of their distribution repositories, and those of their
 * source repositories that no other project hands out. Called in the
 * deletion's own transaction, BEFORE the rows go (`push_receipts` has no
 * foreign key into the `project` module: it is keyed on GitHub's
 * repository id, so no cascade reaches it). Reads the `project` tables by
 * join, as this module reads the journal's (D28); writes only its own.
 * Nothing on GitHub is touched: no repository is ever deleted there.
 * Returns the number of receipts deleted.
 */
export async function purgeProjectReceipts(tx: Db | Tx, gone: ProjectsGone): Promise<number> {
  const goneIds =
    "projectId" in gone
      ? sql`SELECT ${gone.projectId}::uuid`
      : "classroomId" in gone
        ? sql`SELECT p.id FROM projects p WHERE p.classroom_id = ${gone.classroomId}`
        : sql`SELECT p.id FROM projects p JOIN classrooms c ON c.id = p.classroom_id WHERE c.course_id = ${gone.courseId}`;
  const repoIds = sql`
    SELECT r.github_repo_id FROM project_repos r
      WHERE r.project_id IN (${goneIds}) AND r.github_repo_id IS NOT NULL
    UNION
    SELECT p.distribution_repo_id FROM projects p
      WHERE p.id IN (${goneIds}) AND p.distribution_repo_id IS NOT NULL
    UNION
    SELECT p.source_repo_id FROM projects p
      WHERE p.id IN (${goneIds})
        AND NOT EXISTS (
          SELECT 1 FROM projects other
          WHERE other.source_repo_id = p.source_repo_id AND other.id NOT IN (${goneIds})
        )`;
  const deleted = await tx
    .delete(pushReceipts)
    .where(sql`${pushReceipts.githubRepoId} IN (${repoIds})`)
    .returning({ id: pushReceipts.id });
  return deleted.length;
}
