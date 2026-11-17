/**
 * The `codespace` module's side of the collection at the deadline (ADR-130
 * §4): the order to the portal (`POST /api/assignments/:id/collections`, a
 * service token bound to the request, `portalCall`), and the
 * `codespace_collections` record — claimed before the order (the unique
 * key is the at-most-once), its commit written before the branch moves,
 * settled with its outcome, read for the staff's row. The deadline job
 * (`project/collection.ts`) drives it; re-exported by `service.ts`, the
 * module's entry.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { CodespaceCollectionRequest, CodespaceCollectionResult, collectionsPath, type ProjectRepoCollection } from "@quiz/contracts";
import { storedCollection, type CollectionFailureReason, type CollectionOutcomeName } from "@quiz/domain";

import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { codespaceCollections, projectRepos } from "../../db/schema.js";
import { portalCall } from "./portal.js";

/** Quiz waits this long for the portal's answer; the portal stops at 45 s (ADR-130 §5). */
export const COLLECTION_PORTAL_TIMEOUT_MS = 60_000;

/**
 * The order of one repository's collection, its token issued at `now`: the
 * portal's answer, or null when the portal could not be reached or answered
 * out of contract (`portal_unavailable`). Never logs the order's body.
 */
export async function orderCollection(
  config: AppConfig,
  now: Date,
  projectId: string,
  order: CodespaceCollectionRequest,
): Promise<CodespaceCollectionResult | null> {
  try {
    const res = await portalCall(config, now, "POST", collectionsPath(projectId), CodespaceCollectionRequest.parse(order), COLLECTION_PORTAL_TIMEOUT_MS);
    if (!res.ok) return null;
    const parsed = CodespaceCollectionResult.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The claim of `repoId`'s collection at `deadline`: its row's id, or null when one exists already (never ordered twice). */
export async function claimCollection(db: Db, repoId: string, deadline: Date, now: Date): Promise<string | null> {
  const [row] = await db
    .insert(codespaceCollections)
    .values({ id: randomUUID(), repoId, deadlineAt: deadline, claimedAt: now })
    .onConflictDoNothing()
    .returning({ id: codespaceCollections.id });
  return row?.id ?? null;
}

/** The commit about to move onto `branch`, recorded before the move (§4.3); null: it never reached the branch. */
export async function recordCollectionCommit(db: Db | Tx, id: string, branch: string, sha: string | null): Promise<void> {
  await db.update(codespaceCollections).set({ branch, sha }).where(eq(codespaceCollections.id, id));
}

/** What a settled collection records. */
export interface CollectionSettlement {
  outcome: CollectionOutcomeName;
  reason?: CollectionFailureReason | null;
  unreadable?: number | null;
}

/**
 * The claimed row settled, by the server's clock, its branch and commit as
 * recorded — once: only while unsettled. False when another run settled it
 * first (§5): the caller then audits nothing.
 */
export async function settleCollection(db: Db, id: string, settlement: CollectionSettlement, now: Date): Promise<boolean> {
  const won = await db
    .update(codespaceCollections)
    .set({ outcome: settlement.outcome, reason: settlement.reason ?? null, unreadable: settlement.unreadable ?? null, settledAt: now })
    .where(and(eq(codespaceCollections.id, id), isNull(codespaceCollections.outcome)))
    .returning({ id: codespaceCollections.id });
  return won.length > 0;
}

/**
 * How long a claimed collection is presumed alive (§5): past the 120 s
 * order bound, the 60 s wait for the portal and the GitHub calls that
 * follow, with room to spare. Younger, it is never settled as interrupted.
 */
export const COLLECTION_ALIVE_MS = 5 * 60_000;

/** A project's collections claimed more than {@link COLLECTION_ALIVE_MS} ago and never settled: a crash between the claim and the settlement (§4.3). */
export async function unsettledCollections(db: Db, projectId: string, now: Date) {
  return db
    .select({ id: codespaceCollections.id, repoId: codespaceCollections.repoId, deadlineAt: codespaceCollections.deadlineAt, branch: codespaceCollections.branch, sha: codespaceCollections.sha })
    .from(codespaceCollections)
    .innerJoin(projectRepos, eq(projectRepos.id, codespaceCollections.repoId))
    .where(
      and(
        eq(projectRepos.projectId, projectId),
        isNull(codespaceCollections.outcome),
        lt(codespaceCollections.claimedAt, new Date(now.getTime() - COLLECTION_ALIVE_MS)),
      ),
    );
}

/**
 * A collection of the repository (over a `project_repos` row) is claimed
 * and not settled: its receipt may name a commit on no branch, so no freeze
 * reads it until it is settled (§6), and the deadline job has work left.
 */
export const COLLECTION_UNSETTLED = sql`EXISTS (SELECT 1 FROM ${codespaceCollections} WHERE ${codespaceCollections.repoId} = ${projectRepos.id} AND ${codespaceCollections.outcome} IS NULL)`;

/** Each repository's last collection (by its deadline), for the staff's rows (ADR-130 §7). */
export async function lastCollections(db: Db, repoIds: readonly string[]): Promise<Map<string, ProjectRepoCollection>> {
  const out = new Map<string, ProjectRepoCollection>();
  if (repoIds.length === 0) return out;
  const rows = await db
    .select()
    .from(codespaceCollections)
    .where(inArray(codespaceCollections.repoId, [...repoIds]))
    .orderBy(desc(codespaceCollections.deadlineAt));
  for (const row of rows) {
    if (out.has(row.repoId)) continue;
    out.set(row.repoId, {
      // A value the current lists no longer hold (an old row) reads as `failed`.
      ...storedCollection(row.outcome, row.reason),
      deadlineAt: row.deadlineAt.toISOString(),
      at: (row.settledAt ?? row.claimedAt).toISOString(),
      unreadable: row.unreadable,
      sha: row.sha,
    });
  }
  return out;
}
