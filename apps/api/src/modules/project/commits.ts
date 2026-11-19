/**
 * The commits of a repository as a STUDENT counts them (F-PROJ-04 amended,
 * N-SEC-20, M3-14i/M3-14m): the distinct commits of the pushes no bot made,
 * received by the repository's effective deadline. A collection's receipt
 * (ADR-130 §6) is no push of the student's: the platform made that commit
 * from the online workspace, so it is not counted, by the student's view
 * nor by the staff's. ONE implementation behind
 * the student's card and view (`studentView.ts`) and the staff page's rows
 * (`detail.ts`): the two numbers cannot drift. It reads `push_receipts`
 * alone, so it needs no GitHub call.
 *
 * The same receipts say who authored those commits (ADR-136, STAFF ONLY):
 * {@link attributedReceipts} and {@link repoCommits}, the staff's page
 * alone — the student's loader reads {@link countedReceipts}, which never
 * selects the authors.
 */
import { commitAttribution, effectiveDeadline, studentCommitCount, type AttributedReceipt, type CommitAttribution, type CountedReceipt } from "@quiz/domain";
import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { pushReceipts } from "../../db/schema.js";
import type { RepoRow } from "./repos.js";
import type { ProjectRow } from "./views.js";

/** The receipts no bot pushed (`is_bot` false) and no collection wrote (`collected` false) of GitHub repositories `ids`. */
const counted = (ids: readonly number[]) => and(inArray(pushReceipts.githubRepoId, [...ids]), eq(pushReceipts.isBot, false), eq(pushReceipts.collected, false));

function byRepo<R extends { githubRepoId: number }>(rows: R[]): Map<number, Omit<R, "githubRepoId">[]> {
  const receipts = new Map<number, Omit<R, "githubRepoId">[]>();
  for (const { githubRepoId, ...r } of rows) receipts.set(githubRepoId, [...(receipts.get(githubRepoId) ?? []), r]);
  return receipts;
}

/** The counted receipts of GitHub repositories `ids`, by id: one read, whatever the count. */
export async function countedReceipts(db: Db, ids: readonly number[]): Promise<Map<number, CountedReceipt[]>> {
  if (ids.length === 0) return new Map();
  const { githubRepoId, receivedAt, commits } = pushReceipts;
  return byRepo(await db.select({ githubRepoId, receivedAt, commits }).from(pushReceipts).where(counted(ids)));
}

/** {@link countedReceipts} with their commits' authors (ADR-136): the staff's page only. */
export async function attributedReceipts(db: Db, ids: readonly number[]): Promise<Map<number, AttributedReceipt[]>> {
  if (ids.length === 0) return new Map();
  const { githubRepoId, receivedAt, commits, authors } = pushReceipts;
  return byRepo(await db.select({ githubRepoId, receivedAt, commits, authors }).from(pushReceipts).where(counted(ids)));
}

/** `repo`'s own receipts (none while it has no GitHub repository). */
const ownReceipts = <R>(repo: RepoRow, receipts: ReadonlyMap<number, readonly R[]>): readonly R[] =>
  repo.githubRepoId === null ? [] : (receipts.get(repo.githubRepoId) ?? []);

/** The student's commit count of `repo`, from {@link countedReceipts}. */
export function repoCommitCount(project: ProjectRow, repo: RepoRow, receipts: ReadonlyMap<number, readonly CountedReceipt[]>): number {
  return studentCommitCount(ownReceipts(repo, receipts), effectiveDeadline(repo, project));
}

/**
 * `repo`'s commits for the staff (ADR-136): the same count as
 * {@link repoCommitCount}, each of `members` — its readers by roster line,
 * with their linked GitHub account's id, null without one — and the
 * unattributed rest, by week (`commitAttribution` of `@quiz/domain`).
 */
export function repoCommits(
  project: ProjectRow,
  repo: RepoRow,
  receipts: ReadonlyMap<number, readonly AttributedReceipt[]>,
  members: ReadonlyMap<string, number | null>,
): CommitAttribution<string> {
  return commitAttribution(ownReceipts(repo, receipts), effectiveDeadline(repo, project), members);
}
