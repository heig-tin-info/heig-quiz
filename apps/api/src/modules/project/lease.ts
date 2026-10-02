/**
 * The leases of a project's GitHub work (ADR-064 §3 and its addendum,
 * merge tasks M3-05a and M3-05b): one column of `projects` per kind of work
 * — `deadline_job_at` for the deadline's locks and commits (`jobs.ts`),
 * `dispatch_job_at` for the review dispatches (`review.ts`) — so that the
 * two never wait for each other, and one way to take, renew, backdate and
 * give back either. A queue's dedupe is never relied upon (#273).
 */
import type { FastifyInstance } from "fastify";
import { and, eq, isNull, lt, or, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { projects } from "../../db/schema.js";

/** A lease older than this was left by a job that crashed or gave up: the work is claimed again. */
export const LEASE_MS = 10 * 60_000;
/** A job that failed leaves its work to be claimed again this soon (N-PERF-07: 100 repositories in 5 minutes). */
export const FAILED_RETRY_MS = 30_000;

/** Repositories a job settles at once: GitHub's secondary limits frown on more parallel writes. */
export const REPO_CONCURRENCY = 4;

/** The column of `projects` that holds a kind of work's lease. */
export type LeaseKey = "deadlineJobAt" | "dispatchJobAt";

/** One project's work, as the queue carries it: the lease it was claimed under. */
export interface ProjectJob {
  projectId: string;
  /** The lease column as the claim set it (ISO). */
  lease: string;
}

/**
 * The lease `key` of every project where `work` holds (a condition over
 * `projects`), or of `projectId` only, taken when it is free or expired.
 * One conditional UPDATE: two claimers never both get it.
 */
export async function claimLeases(db: Db, key: LeaseKey, now: Date, work: SQL, projectId?: string): Promise<ProjectJob[]> {
  const column = projects[key];
  const rows = await db
    .update(projects)
    .set({ [key]: now })
    .where(
      and(
        projectId === undefined ? undefined : eq(projects.id, projectId),
        or(isNull(column), lt(column, new Date(now.getTime() - LEASE_MS))),
        work,
      ),
    )
    .returning({ projectId: projects.id, lease: column });
  return rows.map((r) => ({ projectId: r.projectId, lease: r.lease!.toISOString() }));
}

/**
 * The lease `key` a job holds, renewed after each repository it settles —
 * so a long job is never taken over while it works — one renewal at a time.
 * Lost when a renewal finds the row holding another lease: another job
 * took the work over (this one outlived its lease), and this one stops.
 */
export function heldLease(app: FastifyInstance, key: LeaseKey, projectId: string, lease: Date) {
  const column = projects[key];
  let held = lease;
  let lost = false;
  let queue: Promise<void> = Promise.resolve();
  const whileHeld = (write: (held: Date) => Promise<unknown[]>, next: () => Date | null) =>
    (queue = queue.then(async () => {
      if (lost) return;
      const rows = await write(held);
      if (rows.length === 0) lost = true;
      else held = next() ?? held;
    }));
  const set = (value: Date | null) => (at: Date) =>
    app.db
      .update(projects)
      .set({ [key]: value })
      .where(and(eq(projects.id, projectId), eq(column, at)))
      .returning({ id: projects.id });
  return {
    lost: () => lost,
    renew: () => {
      const now = app.clock.now();
      return whileHeld(set(now), () => now);
    },
    release: () => whileHeld(set(null), () => null),
    /**
     * After a failure: the lease kept but backdated, so that it expires
     * {@link FAILED_RETRY_MS} from now and the next tick claims the work
     * again — within N-PERF-07's five minutes, not ten.
     */
    expireSoon: () => {
      const at = new Date(app.clock.now().getTime() - LEASE_MS + FAILED_RETRY_MS);
      return whileHeld(set(at), () => at);
    },
  };
}

/** `items` through `run`, `limit` at a time, until `stopped`. */
export async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
  stopped: () => boolean,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stopped()) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
