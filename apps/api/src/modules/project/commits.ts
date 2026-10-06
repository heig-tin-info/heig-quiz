/**
 * The commits of a repository as a STUDENT counts them (F-PROJ-04 amended,
 * N-SEC-20, M3-14i/M3-14m): the distinct commits of the pushes no bot made,
 * received by the repository's effective deadline. ONE implementation behind
 * the student's card and view (`studentView.ts`) and the staff page's rows
 * (`detail.ts`): the two numbers cannot drift. It reads `push_receipts`
 * alone, so it needs no GitHub call.
 */
import { effectiveDeadline, studentCommitCount, type CountedReceipt } from "@quiz/domain";
import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { pushReceipts } from "../../db/schema.js";
import type { RepoRow } from "./repos.js";
import type { ProjectRow } from "./views.js";

/** The receipts no bot pushed (`is_bot` false) of GitHub repositories `ids`, by id: one read, whatever the count. */
export async function countedReceipts(db: Db, ids: readonly number[]): Promise<Map<number, CountedReceipt[]>> {
  const receipts = new Map<number, CountedReceipt[]>();
  if (ids.length === 0) return receipts;
  const rows = await db
    .select({ githubRepoId: pushReceipts.githubRepoId, receivedAt: pushReceipts.receivedAt, commits: pushReceipts.commits })
    .from(pushReceipts)
    .where(and(inArray(pushReceipts.githubRepoId, [...ids]), eq(pushReceipts.isBot, false)));
  for (const { githubRepoId, ...r } of rows) {
    const list = receipts.get(githubRepoId) ?? [];
    list.push(r);
    receipts.set(githubRepoId, list);
  }
  return receipts;
}

/** The student's commit count of `repo` (zero while it has no GitHub repository), from {@link countedReceipts}. */
export function repoCommitCount(project: ProjectRow, repo: RepoRow, receipts: ReadonlyMap<number, CountedReceipt[]>): number {
  if (repo.githubRepoId === null) return 0;
  return studentCommitCount(receipts.get(repo.githubRepoId) ?? [], effectiveDeadline(repo, project));
}
