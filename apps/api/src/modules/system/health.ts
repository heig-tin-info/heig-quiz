/**
 * The health checks (N-OPS-03, ADR-055): ONE registry of small named
 * checks, each an async function that measures one thing and returns
 * `{ status, value, cause, details }`. The thresholds that turn a measure
 * into `ok`/`warn`/`fail` are pure rules of `@quiz/domain` (`health.ts`);
 * nothing here decides a threshold.
 *
 * Three readers, one registry:
 *   - `GET /app/api/admin/system` runs every check on demand, behind a short
 *     cache (`systemStatus`);
 *   - `GET /healthz` runs only the cheap ones that touch no table
 *     (`coarseHealth`) and reduces them to coarse words;
 *   - the `health.checks` scheduled task (`alerts.ts`, ADR-055 §5) runs the
 *     same `runChecks` every five minutes, keeps the transitions and tells
 *     the administrators.
 *
 * A check says how bad things are, never who: counts, sizes and durations,
 * no student, no title, no log line (personal data, N-DATA-*).
 */
import { statfs, stat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { FastifyInstance } from "fastify";
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  serviceCheckKey,
  type CheckCause,
  type CheckDetail,
  type CheckStatus,
  type CheckValue,
  type SystemCheck,
  type SystemCheckKey,
  type SystemDeployment,
  type SystemSection,
  type SystemStatus,
} from "@quiz/contracts";
import {
  backupStatus,
  connectionsStatus,
  dbLatencyStatus,
  diskStatus,
  HEALTH_THRESHOLDS,
  jobsStatus,
  llmBudgetStatus,
  OPEN_STATES,
  overdueStatus,
  serverErrorsStatus,
  SERVICE_NAMES,
  servicePolicy,
  serviceStatus,
  taskAttention,
  tickerStatus,
  worstStatus,
  type ServiceName,
} from "@quiz/domain";

import { mailEnabled, teamsEnabled, type AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { evaluations, healthCheckStates } from "../../db/schema.js";
import { githubApp } from "../../github/app.js";
import { serverErrorsOf } from "../../httpMetrics.js";
import { lastTickOf, serviceRecord } from "../../serviceHealth.js";
import { MIGRATIONS_DIR } from "../../paths.js";
import { InProcessQueue } from "../../jobs.js";
import { overdueAttempts, overdueEvaluations } from "../live/service.js";
import { todayBudget } from "../llm/service.js";
import { openStreamCount } from "../realtime/bus.js";
import { runnerCheck } from "../runner/index.js";
import { listScheduledTasks } from "./service.js";

export interface CheckResult {
  status: CheckStatus;
  value?: CheckValue | null;
  cause?: CheckCause | null;
  details?: CheckDetail[];
}

export interface CheckContext {
  app: FastifyInstance;
  config: AppConfig;
  /** The server clock (invariant 5): what "overdue" is measured against. */
  now: Date;
}

export interface HealthCheck {
  key: SystemCheckKey;
  section: SystemSection;
  run: (ctx: CheckContext) => Promise<CheckResult>;
}

/** One check that hangs must not hold the page: it is reported unknown. */
export const CHECK_TIMEOUT_MS = 3_000;

const count = (n: number): CheckValue => ({ kind: "count", n });
const duration = (ms: number): CheckValue => ({ kind: "duration", ms: Math.round(ms) });
const bytes = (n: number): CheckValue => ({ kind: "bytes", n });
const at = (d: Date): CheckValue => ({ kind: "at", iso: d.toISOString() });
/** A detail line about operator data, its values speaking for themselves. */
const named = (name: string, ...values: CheckValue[]): CheckDetail => ({
  subject: { kind: "name", name },
  values: values.map((value) => ({ meaning: null, value })),
  cause: null,
});

/** The rows of a raw query, on either driver (node-postgres or PGlite). */
async function rows<T>(app: FastifyInstance, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = (await app.db.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}

// --- Live exam readiness --------------------------------------------------

async function tickerCheck({ app, config }: CheckContext): Promise<CheckResult> {
  const last = lastTickOf(app);
  if (last === undefined) return { status: "unknown", cause: "ticker.not_in_process" };
  // The wall clock, like the ticker's own bookkeeping: a lag, not a deadline.
  const lag = Date.now() - last;
  const status = tickerStatus(lag, config.TICK_MS);
  return { status, value: duration(lag), cause: status === "ok" ? null : "ticker.stale" };
}

async function overdueAttemptsCheck({ app, now }: CheckContext): Promise<CheckResult> {
  const n = await overdueAttempts(app.db, now, HEALTH_THRESHOLDS.overdueMarginMs);
  const status = overdueStatus(n);
  return { status, value: count(n), cause: status === "ok" ? null : "attempts.overdue" };
}

async function overdueEvaluationsCheck({ app, now }: CheckContext): Promise<CheckResult> {
  const n = await overdueEvaluations(app.db, now, HEALTH_THRESHOLDS.overdueMarginMs);
  const status = overdueStatus(n);
  return { status, value: count(n), cause: status === "ok" ? null : "evaluations.overdue" };
}

async function tasksCheck({ app, now }: CheckContext): Promise<CheckResult> {
  const details: CheckDetail[] = [];
  for (const task of await listScheduledTasks(app.db)) {
    const lastOkAt = task.lastOkAt ? new Date(task.lastOkAt) : null;
    const why = taskAttention({ ...task, lastOkAt }, now);
    if (why === null) continue;
    const since = why === "error" ? task.lastRunAt : task.lastOkAt;
    details.push({
      subject: { kind: "task", key: task.key },
      values: since ? [{ meaning: null, value: at(new Date(since)) }] : [],
      cause: why === "error" ? "tasks.error" : "tasks.overdue",
    });
  }
  const status: CheckStatus = details.length > 0 ? "warn" : "ok";
  return { status, value: count(details.length), cause: status === "ok" ? null : "tasks.attention", details };
}

/**
 * pg-boss, per queue: jobs ready and waiting, the wait of the oldest, and
 * the failures of the last day. Read from the `pgboss` schema directly (no
 * pg-boss API counts failures over a window); the in-process development
 * queue keeps no such record. A job's wait runs from `start_after`, when it
 * became ready (a retry keeps its `created_on`). Tested against a real
 * PostgreSQL by `health.pg.test.ts`; should a pg-boss upgrade reshape the
 * table, the query throws and the check is `unknown` (`check.failed`).
 */
export async function jobsCheck({ app }: CheckContext): Promise<CheckResult> {
  if (!app.boss) return { status: "warn", cause: "jobs.down" };
  if (app.boss instanceof InProcessQueue) return { status: "unknown", cause: "jobs.in_process" };
  const perQueue = await rows<{ name: string; waiting: number; failed: number; wait_ms: number | null }>(
    app,
    sql`SELECT name,
          count(*) FILTER (WHERE state IN ('created', 'retry') AND start_after <= now())::int AS waiting,
          count(*) FILTER (WHERE state = 'failed')::int AS failed,
          (extract(epoch FROM now() - min(start_after) FILTER (WHERE state IN ('created', 'retry')
            AND start_after <= now())) * 1000)::float8 AS wait_ms
        FROM pgboss.job
        WHERE state IN ('created', 'retry')
           OR (state = 'failed' AND completed_on > now() - interval '24 hours')
        GROUP BY name ORDER BY name`,
  );
  let failed = 0;
  const statuses: CheckStatus[] = ["ok"];
  let waitingTooLong = false;
  const details = perQueue.map((q) => {
    // On the database clock, like the jobs' own timestamps.
    const wait = q.wait_ms === null ? null : Math.max(0, Number(q.wait_ms));
    failed += q.failed;
    const status = jobsStatus(q.failed, wait);
    statuses.push(status);
    if (wait !== null && wait > HEALTH_THRESHOLDS.jobWaitWarnMs) waitingTooLong = true;
    const detail: CheckDetail = {
      subject: { kind: "name", name: q.name },
      values: [
        { meaning: "waiting", value: count(q.waiting) },
        { meaning: "failed", value: count(q.failed) },
        ...(wait === null ? [] : [{ meaning: "oldest" as const, value: duration(wait) }]),
      ],
      cause: null,
    };
    return detail;
  });
  const status = worstStatus(statuses);
  const cause: CheckCause | null =
    status === "ok" ? null : waitingTooLong ? "jobs.waiting" : "jobs.failed";
  return { status, value: count(failed), cause, details };
}

async function runnerHealthCheck({ app, config }: CheckContext): Promise<CheckResult> {
  const runner = await runnerCheck(config, app.runner);
  if (runner === "up") return { status: "ok" };
  if (runner === "disabled") return { status: "ok", cause: "runner.disabled" };
  return { status: "fail", cause: "runner.down" };
}

/** The 5xx of the last day in this process, and the routes that answered most of them. */
async function serverErrorsCheck({ app }: CheckContext): Promise<CheckResult> {
  const errors = serverErrorsOf(app);
  if (!errors) return { status: "unknown" };
  const status = serverErrorsStatus(errors.count);
  return {
    status,
    value: count(errors.count),
    cause: status === "ok" ? null : "http.errors",
    // Route templates, never URLs (`httpMetrics.ts`).
    details: errors.top.map((r) => named(r.route, count(r.count))),
  };
}

async function liveEvaluationsCheck({ app }: CheckContext): Promise<CheckResult> {
  const [row] = await app.db
    .select({ n: sql<number>`count(*)::int` })
    .from(evaluations)
    .where(inArray(evaluations.state, [...OPEN_STATES]));
  const n = row?.n ?? 0;
  return { status: "ok", value: count(n), cause: n > 0 ? "evaluations.live" : null };
}

async function liveConnectionsCheck(): Promise<CheckResult> {
  return { status: "ok", value: count(openStreamCount()) };
}

// --- Data and storage -----------------------------------------------------

async function databaseCheck({ app }: CheckContext): Promise<CheckResult> {
  const started = performance.now();
  try {
    await app.db.execute(sql`SELECT 1`);
  } catch {
    return { status: "fail", cause: "database.down" };
  }
  const ms = performance.now() - started;
  const status = dbLatencyStatus(ms);
  return { status, value: duration(ms), cause: status === "ok" ? null : "database.slow" };
}

async function databaseSizeCheck({ app }: CheckContext): Promise<CheckResult> {
  const [size] = await rows<{ bytes: string | number }>(
    app,
    sql`SELECT pg_database_size(current_database()) AS bytes`,
  );
  const tables = await rows<{ name: string; bytes: string | number }>(
    app,
    sql`SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS name,
          pg_total_relation_size(c.oid) AS bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        ORDER BY 2 DESC LIMIT 5`,
  );
  return {
    status: "ok",
    value: size ? bytes(Number(size.bytes)) : null,
    details: tables.map((t) => named(t.name, bytes(Number(t.bytes)))),
  };
}

async function databaseConnectionsCheck({ app }: CheckContext): Promise<CheckResult> {
  const [row] = await rows<{ used: number; max: number }>(
    app,
    sql`SELECT (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend')::int AS used,
          current_setting('max_connections')::int AS max`,
  );
  // PGlite is one embedded backend: nothing to count.
  if (!row || row.used === 0) return { status: "unknown" };
  const status = connectionsStatus(row.used, row.max);
  return {
    status,
    value: { kind: "share", part: row.used, total: row.max, bytes: false },
    cause: status === "ok" || status === "unknown" ? null : "database.connections",
  };
}

/** The nearest existing directory at or above `path` (the store may not exist yet). */
async function existing(path: string): Promise<string> {
  let dir = path;
  for (;;) {
    try {
      await stat(dir);
      return dir;
    } catch {
      const up = dirname(dir);
      if (up === dir) return dir;
      dir = up;
    }
  }
}

/**
 * Free space where the application writes (the question images) and where
 * the backup report lives, one line per filesystem: the dumps sit next to
 * that report on the host.
 */
async function diskCheck({ config }: CheckContext): Promise<CheckResult> {
  const paths = [config.ASSETS_DIR, ...(config.BACKUP_STATUS_FILE ? [dirname(config.BACKUP_STATUS_FILE)] : [])];
  const seen = new Set<number>();
  const details: CheckDetail[] = [];
  const statuses: CheckStatus[] = [];
  let worst: CheckValue | null = null;
  let worstFree = Infinity;
  for (const path of paths) {
    const dir = await existing(path);
    const dev = (await stat(dir)).dev;
    if (seen.has(dev)) continue;
    seen.add(dev);
    const fs = await statfs(dir);
    const total = fs.blocks * fs.bsize;
    const free = fs.bavail * fs.bsize;
    const value: CheckValue = { kind: "share", part: free, total, bytes: true };
    statuses.push(diskStatus(free, total));
    details.push(named(path, value));
    if (total > 0 && free / total < worstFree) {
      worstFree = free / total;
      worst = value;
    }
  }
  const status = worstStatus(statuses);
  return {
    status,
    value: worst,
    cause: status === "warn" || status === "fail" ? "disk.low" : null,
    details: details.length > 1 ? details : [],
  };
}

/**
 * The reports written beside each other in the backup-status directory, one
 * line of JSON each, through a temporary file and a rename: `last.json` by
 * the `backup` service after every dump (`compose.prod.yml`), `offsite.json`
 * by srv's `quiz-offsite-backup` unit after every borg archive
 * (`scripts/offsite-backup/push.sh`). The app never reads a dump nor the
 * borg repository, only these.
 */
const BackupReportFile = z.object({
  finished_at: z.iso.datetime({ offset: true }),
  ok: z.boolean(),
  exit_code: z.number().int().optional(),
  file: z.string().optional(),
  size_bytes: z.number().optional(),
});

/**
 * Where each report lives. Only the dump's is configured; the off-site one is
 * by convention `offsite.json` beside it (the unit quiz-offsite-backup.service
 * passes that path to push.sh), so the one mounted directory holds both.
 */
const REPORT_FILES = {
  backup: (config: AppConfig) => config.BACKUP_STATUS_FILE,
  offsite: (config: AppConfig) => config.BACKUP_STATUS_FILE && join(dirname(config.BACKUP_STATUS_FILE), "offsite.json"),
} as const;

/** One report, judged by the same thresholds whichever copy it describes. */
function reportCheck(kind: keyof typeof REPORT_FILES): HealthCheck["run"] {
  return async ({ config }) => {
    const path = REPORT_FILES[kind](config);
    if (!path) return { status: "unknown", cause: `${kind}.not_configured` };
    let report: z.infer<typeof BackupReportFile>;
    try {
      report = BackupReportFile.parse(JSON.parse(await readFile(path, "utf8")));
    } catch {
      // Absent, half-written or malformed: no report to trust.
      return { status: "warn", cause: `${kind}.missing` };
    }
    const finishedAt = new Date(report.finished_at);
    // The wall clock: the report was stamped by another clock (a container,
    // the host), and an age of a day has nothing to do with the live clock
    // of invariant 5.
    const status = backupStatus({ finishedAt, ok: report.ok }, new Date());
    return {
      status,
      value: at(finishedAt),
      cause: !report.ok ? `${kind}.failed` : status === "ok" ? null : `${kind}.stale`,
      details: report.file
        ? [named(report.file, ...(report.size_bytes === undefined ? [] : [bytes(report.size_bytes)]))]
        : [],
    };
  };
}

// --- Third-party services (ADR-055 §6) ------------------------------------

/**
 * Why a service is not judged on this platform, or null when it is in use:
 * a service that is not configured is neutral (`unknown`), never a failure.
 */
const SERVICE_OFF: Record<ServiceName, (config: AppConfig) => CheckCause | null> = {
  mail: (config) => (mailEnabled(config) ? null : "mail.dry_run"),
  signin: () => null,
  teams: (config) => (teamsEnabled(config) ? null : "service.not_configured"),
  // The grading stub (ADR-045) or the gateway (ADR-058). A master key with no
  // key stored yet reads as `unused`: this verdict is synchronous, from the
  // configuration alone, and the settings screen says the key is missing.
  llm: (config) =>
    config.LLM_PROVIDER === "none" && config.LLM_KEY_SECRET === "" ? "service.not_configured" : null,
  github: (config) => (githubApp(config) === null ? "service.not_configured" : null),
};

const SERVICE_CAUSES: Record<CheckStatus, CheckCause | null> = {
  ok: null,
  warn: "service.failed_recently",
  fail: "service.failing",
  unknown: "service.unused",
};

/**
 * One service, from what this process saw of its calls (`serviceHealth.ts`):
 * the value is the last success, a detail line the last failure (its class
 * and when, and how many in a row), and the verdict `serviceStatus`'s.
 */
function serviceCheck(name: ServiceName): HealthCheck["run"] {
  return async ({ config }) => {
    const off = SERVICE_OFF[name](config);
    if (off) return { status: "unknown", cause: off };
    const record = serviceRecord(name);
    // The wall clock, like the record's own stamps.
    const status = serviceStatus(record, new Date(), servicePolicy(name));
    const details: CheckDetail[] =
      record.lastErrorAt && record.lastError
        ? [
            {
              subject: { kind: "name", name: record.lastError },
              values: [
                { meaning: "lastFailure", value: at(record.lastErrorAt) },
                ...(record.failuresSinceOk > 0
                  ? [{ meaning: "failed" as const, value: count(record.failuresSinceOk) }]
                  : []),
              ],
              cause: null,
            },
          ]
        : [];
    return { status, value: record.lastOkAt ? at(record.lastOkAt) : null, cause: SERVICE_CAUSES[status], details };
  };
}

/**
 * The LLM gateway's spend today against its cap (ADR-058 §7): read from the
 * call log, never by calling the provider. Names no one.
 */
async function llmBudgetCheck({ app, now }: CheckContext): Promise<CheckResult> {
  if (!app.llmGateway.enabled) return { status: "unknown", cause: "service.not_configured" };
  const { spentUsd, capUsd, refused } = await todayBudget(app.db, now);
  const status = llmBudgetStatus(spentUsd, capUsd, refused);
  return {
    status,
    value: { kind: "share", part: Math.round(spentUsd * 100) / 100, total: capUsd, bytes: false },
    cause: status === "ok" ? null : "llm.budget",
  };
}

// --- The registry ---------------------------------------------------------

/** Every check, in the order the screen lists them. */
export const HEALTH_CHECKS: readonly HealthCheck[] = [
  { key: "ticker", section: "live", run: tickerCheck },
  { key: "attempts.overdue", section: "live", run: overdueAttemptsCheck },
  { key: "evaluations.overdue", section: "live", run: overdueEvaluationsCheck },
  { key: "tasks", section: "live", run: tasksCheck },
  { key: "jobs", section: "live", run: jobsCheck },
  { key: "runner", section: "live", run: runnerHealthCheck },
  { key: "http.errors", section: "live", run: serverErrorsCheck },
  { key: "evaluations.live", section: "live", run: liveEvaluationsCheck },
  { key: "connections.live", section: "live", run: liveConnectionsCheck },
  { key: "database", section: "storage", run: databaseCheck },
  { key: "database.size", section: "storage", run: databaseSizeCheck },
  { key: "database.connections", section: "storage", run: databaseConnectionsCheck },
  { key: "disk", section: "storage", run: diskCheck },
  { key: "backup", section: "storage", run: reportCheck("backup") },
  { key: "offsite", section: "storage", run: reportCheck("offsite") },
  ...SERVICE_NAMES.map((name): HealthCheck => ({
    key: serviceCheckKey(name),
    section: "services",
    run: serviceCheck(name),
  })),
  { key: "llm.budget", section: "services", run: llmBudgetCheck },
];

/**
 * One check, bounded: an exception or a hang is reported `unknown` with the
 * cause `check.failed`, logged, and never takes the other checks with it.
 */
async function runOne(ctx: CheckContext, check: HealthCheck, timeoutMs: number): Promise<SystemCheck> {
  let timer: NodeJS.Timeout | undefined;
  let result: CheckResult;
  try {
    result = await Promise.race([
      check.run(ctx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
      }),
    ]);
  } catch (err) {
    ctx.app.log.warn({ err, check: check.key }, "health check failed");
    result = { status: "unknown", cause: "check.failed" };
  } finally {
    clearTimeout(timer);
  }
  return {
    key: check.key,
    section: check.section,
    status: result.status,
    value: result.value ?? null,
    cause: result.cause ?? null,
    details: result.details ?? [],
    checkedAt: new Date().toISOString(),
    // The task's record, not this run's: `systemStatus` fills it in.
    failingSince: null,
  };
}

/** Runs the checks side by side, each within `timeoutMs`; the order of `checks` is kept. */
export async function runChecks(
  app: FastifyInstance,
  config: AppConfig,
  checks: readonly HealthCheck[] = HEALTH_CHECKS,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<SystemCheck[]> {
  const ctx: CheckContext = { app, config, now: app.clock.now() };
  return Promise.all(checks.map((check) => runOne(ctx, check, timeoutMs)));
}

// --- /healthz: the coarse words -------------------------------------------

/**
 * The checks `/healthz` runs on every probe: memory, three small files and
 * the runner's `/health`, no table. The container healthcheck gives the
 * route 5 s and the deploy gates on it, so they are bounded at 1 s all
 * together (they run side by side); a slow one reads as its worst word.
 */
const COARSE: readonly SystemCheckKey[] = ["ticker", "disk", "backup", "offsite", "runner"];
export const COARSE_TIMEOUT_MS = 1_000;

export interface CoarseHealth {
  /** THE rule of the external probe's alarm (deployment.md §7): one place. */
  attention: boolean;
  checks: {
    ticker: "up" | "stale" | "none";
    disk: "ok" | "low" | "unknown";
    /** The dump's report and the off-site copy's: the worse of the two. */
    backup: "ok" | "stale" | "unknown";
    runner: "up" | "down" | "disabled";
  };
}

/** The ticker, the disk, the two backup reports and the runner, reduced to words (ADR-055 §2). */
export async function coarseHealth(app: FastifyInstance, config: AppConfig): Promise<CoarseHealth> {
  const [ticker, disk, backup, offsite, runner] = await runChecks(
    app,
    config,
    COARSE.map((key) => HEALTH_CHECKS.find((c) => c.key === key)!),
    COARSE_TIMEOUT_MS,
  );
  const bad = (c: SystemCheck | undefined) => c?.status === "warn" || c?.status === "fail";
  const checks: CoarseHealth["checks"] = {
    ticker: ticker?.status === "unknown" ? "none" : bad(ticker) ? "stale" : "up",
    disk: bad(disk) ? "low" : disk?.status === "ok" ? "ok" : "unknown",
    backup: [backup, offsite].some(bad)
      ? "stale"
      : backup?.status === "ok" && offsite?.status === "ok"
        ? "ok"
        : "unknown",
    // A runner that did not answer within the bound counts as down.
    runner: runner?.status !== "ok" ? "down" : runner.cause === "runner.disabled" ? "disabled" : "up",
  };
  const attention =
    checks.ticker === "stale" || checks.disk === "low" || checks.backup === "stale" || checks.runner === "down";
  return { attention, checks };
}

// --- The admin endpoint ---------------------------------------------------

/** One status serves every admin tab for this long; Refresh (`fresh`) bypasses it. */
export const STATUS_CACHE_MS = 20_000;

const cache = new WeakMap<FastifyInstance, { at: number; value: Promise<SystemStatus> }>();

/** The deployment journal's tags by `when`, read once per process. */
let tags: Map<number, string> | undefined;
async function migrationTag(when: number): Promise<string | null> {
  if (!tags) {
    try {
      const journal = JSON.parse(await readFile(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
        entries: { when: number; tag: string }[];
      };
      tags = new Map(journal.entries.map((e) => [e.when, e.tag]));
    } catch {
      tags = new Map();
    }
  }
  return tags.get(when) ?? null;
}

async function deployment(app: FastifyInstance, config: AppConfig): Promise<SystemDeployment> {
  let migration: string | null = null;
  try {
    const [last] = await rows<{ created_at: string | number }>(
      app,
      sql`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`,
    );
    if (last) migration = (await migrationTag(Number(last.created_at))) ?? `#${last.created_at}`;
  } catch {
    // A database down: the database line says so.
  }
  let host = config.PUBLIC_URL;
  try {
    host = new URL(config.PUBLIC_URL).host;
  } catch {
    // Not a URL: shown as configured.
  }
  return {
    commitSha: config.COMMIT_SHA || null,
    commitDate: config.COMMIT_DATE || null,
    migration,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    node: process.version,
    workerMode: config.WORKER_MODE,
    nodeEnv: config.NODE_ENV,
    host,
  };
}

/**
 * Since when each check that failed at the `health.checks` task's last run
 * has been failing (`health_check_states`, written by `alerts.ts`).
 */
export async function failingSince(db: Db): Promise<Map<SystemCheckKey, Date>> {
  const rows = await db
    .select({ key: healthCheckStates.key, since: healthCheckStates.since })
    .from(healthCheckStates)
    .where(eq(healthCheckStates.status, "fail"));
  return new Map(rows.map((row) => [row.key, row.since]));
}

/**
 * Since when the checks that fail now have been failing, by the record of
 * the `health.checks` task: its streak, when its last run saw the check fail
 * too. Nothing when the database cannot say (its own line says why).
 */
async function withFailingSince(app: FastifyInstance, checks: SystemCheck[]): Promise<SystemCheck[]> {
  if (!checks.some((c) => c.status === "fail")) return checks;
  const since = await failingSince(app.db).catch(() => new Map<SystemCheckKey, Date>());
  return checks.map((c) =>
    c.status === "fail" && since.has(c.key) ? { ...c, failingSince: since.get(c.key)!.toISOString() } : c,
  );
}

async function compute(app: FastifyInstance, config: AppConfig): Promise<SystemStatus> {
  const [checks, deployed] = await Promise.all([runChecks(app, config), deployment(app, config)]);
  return { checkedAt: new Date().toISOString(), checks: await withFailingSince(app, checks), deployment: deployed };
}

/**
 * The whole status, cached for `STATUS_CACHE_MS` so that tabs polling it
 * cost one computation between them (concurrent callers share the one in
 * flight); `fresh` recomputes.
 */
export async function systemStatus(
  app: FastifyInstance,
  config: AppConfig,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<SystemStatus> {
  const hit = cache.get(app);
  if (hit && !fresh && Date.now() - hit.at < STATUS_CACHE_MS) return hit.value;
  const value = compute(app, config);
  cache.set(app, { at: Date.now(), value });
  value.catch(() => cache.delete(app));
  return value;
}
