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
import { ForgeUnconfiguredError, type Forge, type ForgeOwner } from "./forge.js";
import { git, gitAuthEnv, GitError, redactSecrets } from "./gitRunner.js";
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

/**
 * Refspec for one event: an exact sha onto its ref, NEVER forced (ADR-078
 * §6). A relay push is a fast-forward or nothing, so it can never erase a
 * commit of Quiz's App (a restore, a sync, a deadline commit) nor anything
 * else on the forge. A deletion is never relayed (the caller marks it).
 */
export function refspecFor(row: Pick<PushEventRow, "ref" | "sha">): string {
  return `${row.sha}:${row.ref}`;
}

/** The reason a deletion's row carries: the relay never deletes a branch on the forge. */
export const DELETION_NOT_RELAYED = "branch deletion not relayed (ADR-078 §6)";

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

/** A ref the forge refused for good, as `git push --porcelain` reports it. */
export interface RefRejection {
  ref: string;
  /** Git's or the forge's words: `non-fast-forward`, `fetch first`, a protection's message. */
  reason: string;
  /** The forge holds commits the staging repository lacks: its head is fetched back (§6). */
  behind: boolean;
}

/**
 * The refs a failed `push --atomic --porcelain` refused for a reason of
 * their own: `!\t<src>:<dst>\t[rejected] (<reason>)` (git's own check, a
 * non-fast-forward) or `[remote rejected] (<reason>)` (the forge's: a
 * ruleset, a workflow file without the `workflows` permission). The refs
 * refused only because `--atomic` took the whole push down are left out:
 * they are retried.
 */
export function parseRejections(porcelain: string): RefRejection[] {
  const out: RefRejection[] = [];
  for (const line of porcelain.split("\n")) {
    const m = /^!\t[^\t]*:([^\t]+)\t\[(rejected|remote rejected)\] \((.*)\)\s*$/.exec(line);
    if (!m) continue;
    const [, ref, kind, reason] = m as unknown as [string, string, string, string];
    if (/atomic/i.test(reason)) continue;
    out.push({ ref, reason, behind: kind === "rejected" && /non-fast-forward|fetch first/.test(reason) });
  }
  return out;
}

/** GitHub refused the credential itself (an expired or revoked token): the forge forgets it. */
function credentialRefused(message: string): boolean {
  return /\b(401|403)\b|Authentication failed|Permission to .* denied/i.test(message);
}

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

/** How many rows a pass moved, by the state they took (`retried`: still pending). */
export interface RelayPassResult {
  relayed: number;
  retried: number;
  failed: number;
  rejected: number;
}

export interface RelayWorker extends RelayScheduler {
  /** One pass over the due events. Returns how many rows moved. */
  runOnce(): Promise<RelayPassResult>;
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
  let running: Promise<RelayPassResult> | null = null;

  /**
   * The forge refused some refs for good (ADR-078 §6): their rows take the
   * terminal `rejected` with the forge's reason; a branch the forge holds
   * ahead (a commit of Quiz's App) is fetched back into the staging
   * repository — the branch there moves to the forge's head, so the
   * student's next pull brings that commit in and their next push
   * fast-forwards; their own commit survives in their workspace clone and in
   * the row (ref, sha). The other refs of the atomic push are retried at once.
   */
  async function settleRejections(
    rejections: RefRejection[],
    rows: PushEventRow[],
    gitDir: string,
    url: string,
    authorization: string,
    result: RelayPassResult,
  ): Promise<void> {
    const refused = new Set(rejections.map((r) => r.ref));
    for (const rejection of rejections) {
      if (rejection.behind && rejection.ref.startsWith("refs/heads/")) {
        try {
          await git(["--git-dir", gitDir, "fetch", "--no-tags", url, `+${rejection.ref}:${rejection.ref}`], {
            env: buildPushEnv(authorization, opts.forge.headerScope),
            ...(opts.pushTimeoutMs === undefined ? {} : { timeoutMs: opts.pushTimeoutMs }),
          });
        } catch (err) {
          opts.log?.warn({ ref: rejection.ref, err: redactSecrets(String((err as Error).message ?? err)) }, "fetching the forge's head after a rejection failed");
        }
      }
      const ids = rows.filter((r) => r.ref === rejection.ref).map((r) => r.id);
      await opts.store.markRejected(ids, rejection.reason);
      result.rejected += ids.length;
    }
    const rest = rows.filter((r) => !refused.has(r.ref)).map((r) => r.id);
    if (rest.length > 0) {
      await opts.store.markRetry(rest, now(), "another ref of the atomic push was rejected");
      result.retried += rest.length;
    }
  }

  async function pass() {
    const due = await opts.store.dueForRelay(now(), batchSize);
    const result: RelayPassResult = { relayed: 0, retried: 0, failed: 0, rejected: 0 };
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

    for (const group of groups.values()) {
      const first = group[0] as PushEventRow;
      const target = await opts.targets.forEvent(first);
      if (!target?.repo) {
        // No forge repository for this assignment: the staging repository is
        // the final destination. Leaving the rows pending would retry
        // forever, so they are closed out here.
        await opts.store.markRelayed(group.map((r) => r.id), now());
        result.relayed += group.length;
        continue;
      }
      // Only the last value of each ref is worth pushing; a ref whose last
      // value is a deletion is not relayed at all (ADR-078 §6).
      const latest = new Map<string, PushEventRow>();
      for (const row of group) latest.set(row.ref, row);
      const deleted = new Set([...latest.values()].filter((r) => r.sha === NULL_OID).map((r) => r.ref));
      if (deleted.size > 0) {
        const gone = group.filter((r) => deleted.has(r.ref)).map((r) => r.id);
        await opts.store.markRejected(gone, DELETION_NOT_RELAYED);
        result.rejected += gone.length;
      }
      const rows = group.filter((r) => !deleted.has(r.ref));
      if (rows.length === 0) continue;
      const ids = rows.map((r) => r.id);
      const heads = [...latest.values()].filter((r) => r.sha !== NULL_OID);
      const refspecs = heads.map(refspecFor);
      const key = `${first.student} ${first.assignment}`;
      const owner: ForgeOwner = { assignment: first.assignment, student: first.student };
      const url = opts.forge.pushUrl(target.repo);
      let authorization: string | null = null;

      try {
        await opts.forge.ensureRepo(target.repo);
        authorization = await opts.forge.authorization(target.repo, owner);
        // Declared before the push, so that the platform reads the forge's
        // event of these heads as the student's (ADR-078 §2, §6).
        await opts.forge.declareHeads?.(target.repo, owner, heads.map(({ ref, sha }) => ({ ref, sha })));
        await git(buildPushArgs(target.gitDir, url, refspecs), {
          env: buildPushEnv(authorization, opts.forge.headerScope),
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
        const rejections = err instanceof GitError ? parseRejections(err.stdout) : [];
        if (rejections.length > 0 && authorization !== null) {
          await settleRejections(rejections, rows, target.gitDir, url, authorization, result);
          opts.log?.warn(
            { student: first.student, assignment: first.assignment, refs: rejections.map((r) => ({ ref: r.ref, reason: r.reason })) },
            "relay rejected by the forge: the refs are marked rejected",
          );
          continue;
        }
        // The credential itself refused: forgotten, the next attempt asks for a new one, once.
        if (err instanceof GitError && credentialRefused(err.message)) opts.forge.invalidate?.(target.repo, owner);
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
