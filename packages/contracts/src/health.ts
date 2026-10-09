import { z } from "zod";

import { CHECK_STATUSES, SERVICE_NAMES, type CheckStatus, type ServiceName } from "@quiz/domain";

import { SCHEDULED_TASK_KEYS } from "./admin.js";

const HealthStatus = z.enum(["ok", "degraded"]);

/**
 * `GET /healthz`: PUBLIC, probed by the container healthcheck, the deploy
 * gate (ADR-028) and an external uptime service. It stays NARROW (ADR-055):
 * a 503 only when the database is down, and coarse words only — never a
 * path, a size, a name or a number beyond the uptime. The details are the
 * administrators' (`SystemStatus`).
 */
export const HealthResponse = z.object({
  status: HealthStatus,
  /**
   * `true` when one of the coarse checks below needs the operator (a stale
   * ticker, a low disk, a stale or failed backup, a configured runner that
   * does not answer). The external probe alerts on it (deployment.md §7);
   * it never changes the HTTP status.
   */
  attention: z.boolean(),
  checks: z.object({
    database: z.enum(["up", "down"]),
    jobs: z.enum(["up", "down"]),
    /**
     * The code runner. `disabled` is `RUNNER_MODE=stub`, the default: the
     * platform is running as configured, so it is not a failure (decision D14).
     */
    runner: z.enum(["up", "down", "disabled"]),
    /** The live clock of this process; `none` in `WORKER_MODE=web`. */
    ticker: z.enum(["up", "stale", "none"]),
    disk: z.enum(["ok", "low", "unknown"]),
    /**
     * The worse of the dump's report and the off-site copy's (deployment.md
     * §6). `unknown`: no backup report configured (development, staging).
     */
    backup: z.enum(["ok", "stale", "unknown"]),
  }),
  uptimeSeconds: z.number(),
});

export type HealthResponse = z.infer<typeof HealthResponse>;

// --- The system status (N-OPS-03, ADR-055) -------------------------------

/** The check key of a third-party service (ADR-055 §6). */
export const serviceCheckKey = <N extends ServiceName>(name: N) => `service.${name}` as const;

/** `service.<name>` for every service of `SERVICE_NAMES`, in its order. */
type ServiceCheckKeys<T extends readonly ServiceName[]> = { readonly [K in keyof T]: `service.${T[K] & string}` };
export const SERVICE_CHECK_KEYS = SERVICE_NAMES.map(serviceCheckKey) as unknown as ServiceCheckKeys<
  typeof SERVICE_NAMES
>;

/**
 * Every check of the registry (`apps/api/src/modules/system/health.ts`), a
 * closed list: the admin screen names each one in both languages, or does
 * not compile.
 */
export const SYSTEM_CHECK_KEYS = [
  // Live exam readiness.
  "ticker",
  "attempts.overdue",
  "evaluations.overdue",
  "tasks",
  "jobs",
  "runner",
  "http.errors",
  "evaluations.live",
  "connections.live",
  // Data and storage.
  "database",
  "database.size",
  "database.connections",
  "disk",
  "backup",
  // The off-site copy of the backups (deployment.md §6, ADR-055 §4).
  "offsite",
  // Third-party services, judged from the process's own traffic (ADR-055 §6).
  ...SERVICE_CHECK_KEYS,
  // The LLM gateway's spend today against its daily cap (ADR-058 §7).
  "llm.budget",
] as const;
export type SystemCheckKey = (typeof SYSTEM_CHECK_KEYS)[number];

export const SYSTEM_SECTIONS = ["live", "storage", "services"] as const;
export type SystemSection = (typeof SYSTEM_SECTIONS)[number];

/**
 * Why a check is not plainly `ok`, as a closed list the screen words in
 * both languages (one sentence each). The values of the check fill it in.
 */
export const CHECK_CAUSES = [
  "ticker.stale",
  "ticker.not_in_process",
  "attempts.overdue",
  "evaluations.overdue",
  "tasks.attention",
  "tasks.error",
  "tasks.overdue",
  "jobs.failed",
  "jobs.waiting",
  "jobs.in_process",
  "jobs.down",
  "runner.down",
  "runner.disabled",
  "evaluations.live",
  "database.down",
  "database.slow",
  "database.connections",
  "disk.low",
  "backup.not_configured",
  "backup.missing",
  "backup.failed",
  "backup.stale",
  "offsite.not_configured",
  "offsite.missing",
  "offsite.failed",
  "offsite.stale",
  "http.errors",
  "service.not_configured",
  "service.unused",
  "service.failed_recently",
  "service.failing",
  "llm.budget",
  "mail.dry_run",
  "check.failed",
] as const;
export type CheckCause = (typeof CHECK_CAUSES)[number];

/**
 * A measured value, formatted by the client in its locale: a count, a
 * duration, a size, a part of a whole, an instant.
 */
export const CheckValue = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("count"), n: z.number().int() }),
  z.object({ kind: z.literal("duration"), ms: z.number() }),
  z.object({ kind: z.literal("bytes"), n: z.number() }),
  /** `used` of `total` (connections), or `free` bytes of `total` (disk, `bytes: true`). */
  z.object({ kind: z.literal("share"), part: z.number(), total: z.number(), bytes: z.boolean() }),
  z.object({ kind: z.literal("at"), iso: z.iso.datetime() }),
]);
export type CheckValue = z.infer<typeof CheckValue>;

/**
 * What a value under a check means, when its kind alone does not say it:
 * the screen words it ("3 waiting", "oldest 2 min"). `null`: the value
 * speaks for itself (a size, an instant).
 */
export const DETAIL_MEANINGS = ["waiting", "failed", "oldest", "lastFailure"] as const;
export type DetailMeaning = (typeof DETAIL_MEANINGS)[number];

/**
 * A line under a check: a table and its size, a queue and its counts, a
 * mount and its free space, a task that needs a look. Its subject is either
 * a scheduled task (named by the screen, in its language) or operator data
 * (a table, a queue, a path, a dump), shown as is, like a log line.
 */
export const CheckDetail = z.object({
  subject: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("task"), key: z.enum(SCHEDULED_TASK_KEYS) }),
    z.object({ kind: z.literal("name"), name: z.string() }),
  ]),
  values: z.array(z.object({ meaning: z.enum(DETAIL_MEANINGS).nullable(), value: CheckValue })),
  /** Why this line is listed, when the check lists only what needs a look. */
  cause: z.enum(CHECK_CAUSES).nullable(),
});
export type CheckDetail = z.infer<typeof CheckDetail>;

export const SystemCheck = z.object({
  key: z.enum(SYSTEM_CHECK_KEYS),
  section: z.enum(SYSTEM_SECTIONS),
  status: z.enum(CHECK_STATUSES),
  value: CheckValue.nullable(),
  cause: z.enum(CHECK_CAUSES).nullable(),
  details: z.array(CheckDetail),
  checkedAt: z.iso.datetime(),
  /**
   * While the check fails, since when: the first failed run of the streak
   * the `health.checks` task recorded (ADR-055 §5). `null` when it does not
   * fail, or the task has not seen it fail yet.
   */
  failingSince: z.iso.datetime().nullable(),
});
export type SystemCheck = z.infer<typeof SystemCheck>;

/** What is deployed: the answer to "which version is this?". */
export const SystemDeployment = z.object({
  commitSha: z.string().nullable(),
  commitDate: z.string().nullable(),
  /** The last migration applied, by its tag in drizzle's journal (`0042_scheduled_tasks`). */
  migration: z.string().nullable(),
  startedAt: z.iso.datetime(),
  node: z.string(),
  workerMode: z.enum(["all", "web", "worker"]),
  nodeEnv: z.enum(["development", "test", "production"]),
  /** The host of `PUBLIC_URL`: tells production from staging. */
  host: z.string(),
});
export type SystemDeployment = z.infer<typeof SystemDeployment>;

/** `GET /app/api/admin/system` (admin only). */
export const SystemStatus = z.object({
  checkedAt: z.iso.datetime(),
  checks: z.array(SystemCheck),
  deployment: SystemDeployment,
});
export type SystemStatus = z.infer<typeof SystemStatus>;

/**
 * `POST /app/api/admin/system/test-mail` (admin only, no body): a short
 * test message to the calling administrator, through the platform's mailer
 * and nothing else (no notification preference). `dry_run`: no Scaleway
 * credentials, the message was only logged. `error`: the provider refused
 * or did not answer, `error` its class (`http_502`, `timeout`), never its
 * words. Refused with 429 `rate_limited` within a minute of the last one.
 */
export const TestMailResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("sent") }),
  z.object({ outcome: z.literal("dry_run") }),
  z.object({ outcome: z.literal("error"), error: z.string() }),
]);
export type TestMailResult = z.infer<typeof TestMailResult>;

/** `?fresh=1` skips the short server cache (the screen's Refresh). */
export const SystemStatusQuery = z.object({ fresh: z.enum(["0", "1"]).optional() });
export type SystemStatusQuery = z.infer<typeof SystemStatusQuery>;
