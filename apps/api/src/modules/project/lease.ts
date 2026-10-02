/**
 * The leases of a project's GitHub work (ADR-064 §3 and its addendum,
 * merge tasks M3-05a and M3-05b): one column of `projects` per kind of work
 * — `deadline_job_at` for the deadline's locks and commits (`jobs.ts`),
 * `dispatch_job_at` for the review dispatches (`review.ts`) — so that the
 * two never wait for each other, and ONE frame for the jobs that hold them
 * ({@link runLeased}): take, renew, backdate and give back. A queue's
 * dedupe is never relied upon (#273).
 */
import type { FastifyInstance } from "fastify";
import { and, eq, isNull, lt, or, type SQL } from "drizzle-orm";
import type { Octokit } from "octokit";

import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { projects } from "../../db/schema.js";
import { installationClient } from "../../github/app.js";
import { projectInstallation } from "../github/service.js";
import type { ProjectRow } from "./views.js";

/** A lease older than this was left by a job that crashed or gave up: the work is claimed again. */
export const LEASE_MS = 10 * 60_000;
/** A job that failed leaves its work to be claimed again this soon (N-PERF-07: 100 repositories in 5 minutes). */
export const FAILED_RETRY_MS = 30_000;
/** Repositories a job settles at once: GitHub's secondary limits frown on more parallel writes. */
const REPO_CONCURRENCY = 4;

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
 * so a long job is never taken over while it works — one write at a time.
 * Lost when a write finds the row holding another lease: another job took
 * the work over (this one outlived its lease), and this one stops.
 */
function heldLease(app: FastifyInstance, key: LeaseKey, projectId: string, lease: Date) {
  const column = projects[key];
  let held = lease;
  let lost = false;
  let queue: Promise<void> = Promise.resolve();
  const whileHeld = (value: Date | null) =>
    (queue = queue.then(async () => {
      if (lost) return;
      const rows = await app.db
        .update(projects)
        .set({ [key]: value })
        .where(and(eq(projects.id, projectId), eq(column, held)))
        .returning({ id: projects.id });
      if (rows.length === 0) lost = true;
      else if (value !== null) held = value;
    }));
  return {
    lost: () => lost,
    renew: () => whileHeld(app.clock.now()),
    release: () => whileHeld(null),
    /**
     * After a failure: the lease kept but backdated, so that it expires
     * {@link FAILED_RETRY_MS} from now and the next tick claims the work
     * again — within N-PERF-07's five minutes, not ten.
     */
    expireSoon: () => whileHeld(new Date(app.clock.now().getTime() - LEASE_MS + FAILED_RETRY_MS)),
  };
}

/** `items` through `run`, `limit` at a time, until `stopped`. */
export async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
  stopped: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stopped()) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** What a leased job's body works with. */
export interface LeasedRun {
  project: ProjectRow;
  octokit: Octokit;
  lost: () => boolean;
  /**
   * `repos` through `settle`, four at a time, the lease renewed after each,
   * until it is lost. A repository whose `settle` throws is logged and
   * counted failed: its full name is in the list returned, and the job
   * fails once its body is done.
   */
  each: <R extends { fullName: string | null }>(repos: readonly R[], settle: (repo: R) => Promise<void>) => Promise<string[]>;
}

/**
 * The frame of a leased job (`project.deadline`, `project.dispatch`):
 * nothing when the lease is no longer the job's (given back, or taken over
 * after it expired); without the App on the organization it waits, the
 * lease kept, for the sweep ten minutes on — no retry loop. Then `body`;
 * afterwards nothing more when the lease was lost (the job that took over
 * finishes the work), a backdated lease and a throw when a repository
 * failed (the next tick resumes), else the lease given back.
 */
export async function runLeased(
  app: FastifyInstance,
  config: AppConfig,
  key: LeaseKey,
  job: ProjectJob,
  label: string,
  body: (run: LeasedRun) => Promise<void>,
): Promise<void> {
  const [project] = await app.db.select().from(projects).where(eq(projects.id, job.projectId));
  if (!project || project[key]?.toISOString() !== job.lease) return;
  const org = await projectInstallation(app.db, project.orgId);
  if (!org) return;
  const { octokit } = await installationClient(config, org.installationId);
  const lease = heldLease(app, key, project.id, project[key]);
  const failed: string[] = [];
  const each: LeasedRun["each"] = async (repos, settle) => {
    const mine: string[] = [];
    await forEachLimit(
      repos,
      REPO_CONCURRENCY,
      async (repo) => {
        try {
          await settle(repo);
        } catch (err) {
          app.log.error({ err, repo: repo.fullName }, `${label}: a repository failed`);
          mine.push(repo.fullName!);
        }
        await lease.renew();
      },
      lease.lost,
    );
    failed.push(...mine);
    return mine;
  };
  await body({ project, octokit, lost: lease.lost, each });
  if (lease.lost()) return;
  if (failed.length > 0) {
    await lease.expireSoon();
    throw new Error(`${label} incomplete: ${failed.join(", ")}`);
  }
  await lease.release();
}
