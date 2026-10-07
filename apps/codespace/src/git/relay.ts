/**
 * Relay job: staging repository → forge (analyse.md 3.1).
 *
 * The student's push has already succeeded and is already recorded when this
 * runs. So a forge outage is an *operational* problem, never a pedagogical
 * one: rows stay `pending` and are retried with a backoff until the forge
 * comes back, and only an exhausted attempt budget turns one `failed`.
 *
 * The token never appears in argv (`ps`, `/proc/<pid>/cmdline`) and never
 * touches the disk: it is handed to `git` through `GIT_CONFIG_COUNT` /
 * `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0`, which is the documented way to
 * set `http.extraHeader` without a config file (git ≥ 2.31).
 */
import { NULL_OID, type PushEventRow, type PushEventStore, type RelayScheduler } from "./pushEvents.js";
import { ForgeUnconfiguredError, type Forge } from "./forge.js";
import { git, gitAuthEnv, redactSecrets } from "./gitRunner.js";
import { stagingPaths } from "./staging.js";
import type { RepoRef } from "./types.js";

/** Where a recorded push has to go. */
export interface RelayTarget {
  /** Bare staging repository the refs are read from. */
  gitDir: string;
  /** Absent: the assignment has no forge repository, nothing to relay. */
  repo?: RepoRef;
}

export interface RelayTargets {
  forEvent(row: PushEventRow): Promise<RelayTarget | undefined>;
}

/**
 * Default resolution: the staging path is derived from the event itself, so
 * the relay keeps working after the session is closed and the container
 * destroyed — which is exactly when a long forge outage ends.
 */
export function stagingTargets(
  volumesRoot: string,
  repoOf: (row: PushEventRow) => RepoRef | undefined,
): RelayTargets {
  return {
    async forEvent(row) {
      const paths = stagingPaths(volumesRoot, row.student, row.assignment);
      const repo = repoOf(row);
      return repo ? { gitDir: paths.gitDir, repo } : { gitDir: paths.gitDir };
    },
  };
}

/** Refspec for one event: force-update to an exact sha, or delete. */
export function refspecFor(row: Pick<PushEventRow, "ref" | "sha">): string {
  return row.sha === NULL_OID ? `:${row.ref}` : `+${row.sha}:${row.ref}`;
}

/** Argv of the relay push. Asserted token-free by the tests. */
export function buildPushArgs(gitDir: string, url: string, refspecs: string[]): string[] {
  return ["--git-dir", gitDir, "push", "--atomic", "--porcelain", url, ...refspecs];
}

/**
 * Environment carrying the credential. `GIT_CONFIG_VALUE_0` is visible in
 * `/proc/<pid>/environ` (root, or the same uid) but not in `cmdline`, and
 * nothing is written to a file — the two properties milestone-0 asks for.
 */
export const buildPushEnv = gitAuthEnv;

export interface RelayOptions {
  store: PushEventStore;
  forge: Forge;
  targets: RelayTargets;
  /** Attempts before a row is declared `failed`. */
  maxAttempts?: number;
  /** Backoff in ms for attempt n (1-based). */
  backoffMs?: (attempt: number) => number;
  /**
   * Backoff used when the forge has no credentials at all
   * (`ForgeUnconfiguredError`). Separate from `backoffMs` because the two are
   * not the same kind of wait: an outage is over in minutes, a missing GitHub
   * App is over when a human installs it.
   */
  unconfiguredBackoffMs?: (attempt: number) => number;
  pushTimeoutMs?: number;
  batchSize?: number;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
  now?: () => Date;
}

export interface RelayWorker extends RelayScheduler {
  /** One pass over the due events. Returns how many rows moved. */
  runOnce(): Promise<{ relayed: number; retried: number; failed: number }>;
  /** Periodic pass; the timer is unref'd so it never holds the process up. */
  start(intervalMs?: number): void;
  stop(): void;
}

const DEFAULT_BACKOFF = (attempt: number) =>
  Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));

/**
 * Cadence for a forge that is **not configured**. Measured in production on
 * 2026-09-18: an organisation without a GitHub App (`heig-tin-info`) produced
 * 517 attempts and 517 `warn`s, one per minute, indefinitely — the ceiling of
 * `DEFAULT_BACKOFF` is one minute and the periodic pass runs every five
 * seconds.
 *
 * The "pending, never failed" behaviour stays intentional (the submission
 * never had a destination, this is not an outage); the cadence does not.
 * Exponential from one minute, **capped at one hour**: 1 min, 2, 4, … then one
 * attempt per hour. An App that gets installed is picked up at most one hour
 * later, with no intervention.
 */
export const UNCONFIGURED_BACKOFF = (attempt: number): number =>
  Math.min(3_600_000, 60_000 * 2 ** Math.max(0, attempt - 1));

export function createRelayWorker(opts: RelayOptions): RelayWorker {
  const maxAttempts = opts.maxAttempts ?? 10;
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
  const unconfiguredBackoff = opts.unconfiguredBackoffMs ?? UNCONFIGURED_BACKOFF;
  /**
   * Last cause logged per (student, assignment) pair. A forge that is not
   * configured only deserves one `warn` **per state change**, not one per
   * attempt: the situation is not moving, and the log has to stay readable.
   */
  const lastUnconfigured = new Map<string, string>();
  const batchSize = opts.batchSize ?? 100;
  const now = opts.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<{ relayed: number; retried: number; failed: number }> | null = null;

  async function pass() {
    const due = await opts.store.dueForRelay(now(), batchSize);
    const result = { relayed: 0, retried: 0, failed: 0 };
    if (due.length === 0) return result;

    // One push per (student, assignment): a burst of refs is one round trip,
    // and `--atomic` keeps the forge consistent with the staging repo.
    const groups = new Map<string, PushEventRow[]>();
    for (const row of due) {
      const key = `${row.student}\u0000${row.assignment}`;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }

    for (const rows of groups.values()) {
      const first = rows[0] as PushEventRow;
      const target = await opts.targets.forEvent(first);
      const ids = rows.map((r) => r.id);
      if (!target?.repo) {
        // No forge repository for this assignment: the staging repository is
        // the final destination. Leaving the rows pending would retry
        // forever, so they are closed out here.
        await opts.store.markRelayed(ids, now());
        result.relayed += ids.length;
        continue;
      }
      // Only the last value of each ref is worth pushing.
      const latest = new Map<string, PushEventRow>();
      for (const row of rows) latest.set(row.ref, row);
      const refspecs = [...latest.values()].map(refspecFor);
      const key = `${first.student} ${first.assignment}`;

      try {
        await opts.forge.ensureRepo(target.repo);
        const authorization = await opts.forge.authorization(target.repo);
        await git(buildPushArgs(target.gitDir, opts.forge.pushUrl(target.repo), refspecs), {
          env: buildPushEnv(authorization),
          ...(opts.pushTimeoutMs === undefined ? {} : { timeoutMs: opts.pushTimeoutMs }),
        });
        await opts.store.markRelayed(ids, now());
        result.relayed += ids.length;
        // The forge answers again: the next failure will deserve a `warn`.
        lastUnconfigured.delete(key);
        opts.log?.info(
          { student: first.student, assignment: first.assignment, refs: refspecs.length },
          "push relayed to the forge",
        );
      } catch (err) {
        const message = redactSecrets(String((err as Error).message ?? err));
        // A forge that is **not configured** is not an outage: exhausting the
        // attempt budget would turn `failed` a submission that never had a
        // destination. The rows stay `pending`, with the message in
        // `last_error`, and resume on their own as soon as the operator
        // installs the credentials.
        const unconfigured = err instanceof ForgeUnconfiguredError;
        const exhausted = unconfigured
          ? []
          : rows.filter((r) => r.attempts + 1 >= maxAttempts).map((r) => r.id);
        const retryable = ids.filter((id) => !exhausted.includes(id));
        const attempt = Math.max(...rows.map((r) => r.attempts)) + 1;
        const wait = unconfigured ? unconfiguredBackoff(attempt) : backoff(attempt);
        if (retryable.length > 0) {
          await opts.store.markRetry(retryable, new Date(now().getTime() + wait), message);
          result.retried += retryable.length;
        }
        if (exhausted.length > 0) {
          await opts.store.markFailed(exhausted, message);
          result.failed += exhausted.length;
        }
        if (!unconfigured) {
          opts.log?.warn(
            { student: first.student, assignment: first.assignment, attempt, err: message },
            "relay failed, another attempt scheduled",
          );
        } else if (lastUnconfigured.get(key) !== message) {
          // A single `warn` as long as the cause does not change. Installing
          // the GitHub App makes the relay succeed (or changes the message):
          // the log will say so.
          lastUnconfigured.set(key, message);
          opts.log?.warn(
            {
              student: first.student,
              assignment: first.assignment,
              attempt,
              nextAttemptInMs: wait,
              err: message,
            },
            "relay waiting: the forge is not configured for this repository",
          );
        }
      }
    }
    return result;
  }

  async function runOnce() {
    // Never two passes at once: the second would push the same refs.
    if (running) return running;
    running = pass().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    schedule() {
      // The rows are already stored (invariant 7); a pass is kicked off out
      // of band so the student's push returns without waiting for the forge.
      void runOnce().catch(() => undefined);
    },
    runOnce,
    start(intervalMs = 5000) {
      if (timer) return;
      timer = setInterval(() => void runOnce().catch(() => undefined), intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
