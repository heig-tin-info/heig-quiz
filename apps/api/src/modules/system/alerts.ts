/**
 * The `health.checks` scheduled task (ADR-055 §5): the secondary alarm. It
 * runs the SAME registry as the System status page (`runChecks`), keeps per
 * check what the anti-flap rule needs in `health_check_states` (this
 * module's table), and tells the administrators of a transition through the
 * ordinary notifications (ADR-030, kind `system_alert`): the bell, and an
 * e-mail by default.
 *
 * The primary alarm stays the external probe of `/healthz`
 * (deployment.md §7): this task runs on the ticker's claim, so a dead VM, a
 * crash loop or a ticker dead in every process silences it too. What it adds
 * is the rest of the registry — a failed dump, a full disk, a dead runner,
 * overdue attempts seen from another process — named, with its cause.
 *
 * The rule is `nextCheckState` of `@quiz/domain`; this file only loads the
 * states, stores the next ones, and sends. One run at a time: the scheduled
 * claim never hands a running task out twice (`service.ts`).
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  SYSTEM_ALERT_STATES,
  type NotificationPayload,
  type SystemCheck,
  type SystemCheckKey,
} from "@quiz/contracts";
import { CHECK_STATUSES, nextCheckState, type CheckState } from "@quiz/domain";

import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { healthCheckStates, users } from "../../db/schema.js";
import { notifyMany } from "../notifications/service.js";
import { HEALTH_CHECKS, runChecks, type HealthCheck } from "./health.js";

type SystemAlertPayload = Extract<NotificationPayload, { kind: "system_alert" }>;


type StateRow = typeof healthCheckStates.$inferSelect;

const toState = (row: StateRow): CheckState => ({
  status: row.status,
  since: row.since,
  consecutive: row.consecutive,
  notified: row.notifiedStatus,
  notifiedAt: row.notifiedAt,
});

/** The stored state of `keys`, by key. */
async function loadStates(db: Db, keys: readonly SystemCheckKey[]): Promise<Map<SystemCheckKey, CheckState>> {
  if (keys.length === 0) return new Map();
  const rows = await db.select().from(healthCheckStates).where(inArray(healthCheckStates.key, [...keys]));
  return new Map(rows.map((row) => [row.key, toState(row)]));
}

/** The next state of every check, in one statement. */
async function storeStates(db: Db, states: { key: SystemCheckKey; state: CheckState }[], at: Date): Promise<void> {
  if (states.length === 0) return;
  const excluded = (column: string) => sql.raw(`excluded.${column}`);
  await db
    .insert(healthCheckStates)
    .values(
      states.map(({ key, state }) => ({
        key,
        status: state.status,
        since: state.since,
        consecutive: state.consecutive,
        notifiedStatus: state.notified,
        notifiedAt: state.notifiedAt,
        checkedAt: at,
      })),
    )
    .onConflictDoUpdate({
      target: healthCheckStates.key,
      set: {
        status: excluded("status"),
        since: excluded("since"),
        consecutive: excluded("consecutive"),
        notifiedStatus: excluded("notified_status"),
        notifiedAt: excluded("notified_at"),
        checkedAt: excluded("checked_at"),
      },
    });
}

/** Every administrator account still in use: the recipients of a system alert. */
async function administrators(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), isNull(users.anonymizedAt)));
  return rows.map((row) => row.id);
}

/** "13 ok, 1 warn, 1 unknown": the run's line on the scheduled tasks screen. */
function tally(checks: readonly SystemCheck[]): string {
  return CHECK_STATUSES.map((status) => [status, checks.filter((c) => c.status === status).length] as const)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${status}`)
    .join(", ");
}

/**
 * One run of the task: every check, the next state of each, and at most one
 * notification per kind of notice (failing, still failing, recovered) to
 * each administrator, naming the checks concerned. Returns the English
 * summary the scheduled tasks screen shows.
 *
 * The states are stored BEFORE the notifications are sent, so a notice is
 * sent at most once: a send that fails is logged by the task's run as its
 * error, and not retried — the page, and the probe, still say it.
 */
export async function runHealthAlerts(
  app: FastifyInstance,
  config: AppConfig,
  checks: readonly HealthCheck[] = HEALTH_CHECKS,
): Promise<string> {
  const results = await runChecks(app, config, checks);
  const now = app.clock.now();
  const previous = await loadStates(app.db, results.map((r) => r.key));

  const next = results.map((result) => ({
    result,
    ...nextCheckState(previous.get(result.key) ?? null, result.status, now),
  }));
  await storeStates(
    app.db,
    next.map(({ result, state }) => ({ key: result.key, state })),
    now,
  );

  const payloads: SystemAlertPayload[] = [];
  for (const notice of SYSTEM_ALERT_STATES) {
    const concerned = next.filter((n) => n.notice === notice).map((n) => n.result);
    if (concerned.length === 0) continue;
    payloads.push({
      kind: "system_alert",
      state: notice,
      checks: concerned.map((c) => c.key),
    });
  }

  const summary = tally(results);
  if (payloads.length === 0) return summary;
  const admins = await administrators(app.db);
  await notifyMany(
    app.db,
    admins.flatMap((userId) => payloads.map((payload) => ({ userId, payload }))),
  );
  const told = payloads.map((p) => `${p.state}: ${p.checks.join(", ")}`).join("; ");
  return `${summary}; ${told} (${admins.length} admins told)`;
}
