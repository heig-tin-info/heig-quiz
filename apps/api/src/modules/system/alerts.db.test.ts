/**
 * The `health.checks` task (ADR-055 §5) against the real migrations: the
 * states it keeps across runs, and the notifications it sends — once per
 * transition, to each administrator and to nobody else, the e-mail queued by
 * default and never a Teams message.
 *
 * The registry is a fake one whose verdicts the test sets; the real checks
 * are `health.db.test.ts`'s. The anti-flap rule itself is the domain's
 * (`healthAlert.test.ts`); this file checks it is wired to storage.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NotificationPayload, type CheckStatus, type SystemCheckKey } from "@quiz/contracts";

import type { AppConfig } from "../../config.js";
import { healthCheckStates, notifications, users } from "../../db/schema.js";
import type { JobQueue } from "../../jobs.js";
import { testApp } from "../../test/db.js";
import { deliver, type DeliveryDeps } from "../notifications/jobs.js";
import type { Mail } from "../notifications/mailer.js";
import { closeOutbox, openOutbox, type DeliveryJob } from "../notifications/outbox.js";
import { listNotifications } from "../notifications/service.js";
import { runHealthAlerts } from "./alerts.js";
import { systemStatus, type CheckResult, type HealthCheck } from "./health.js";
import { SCHEDULED_TASKS } from "./catalog.js";

let app: Awaited<ReturnType<typeof testApp>>;
const config = {} as AppConfig;

/** The verdict each fake check gives on the next run. */
let verdicts: Partial<Record<SystemCheckKey, CheckResult>>;
const fake = (key: SystemCheckKey): HealthCheck => ({
  key,
  section: "storage",
  run: async () => verdicts[key] ?? { status: "ok" },
});
const registry = [fake("disk"), fake("backup"), fake("runner")];

const LOW_DISK: CheckResult = {
  status: "fail",
  cause: "disk.low",
  value: { kind: "share", part: 1e9, total: 40e9, bytes: true },
};

async function seedUser(role: "student" | "teacher" | "admin", anonymized = false): Promise<string> {
  const id = randomUUID();
  await app.db.insert(users).values({
    id,
    oidcSub: `s-${id}`,
    email: `${id}@heig.test`,
    role,
    ...(anonymized ? { anonymizedAt: new Date() } : {}),
  });
  return id;
}

async function bellOf(userId: string): Promise<NotificationPayload[]> {
  const rows = await app.db.select().from(notifications).where(eq(notifications.userId, userId));
  return rows.map((row) => NotificationPayload.parse(row.payload));
}

/** One run, five minutes after the previous one. */
async function run(status?: Partial<Record<SystemCheckKey, CheckResult>>): Promise<string> {
  if (status) verdicts = status;
  app.clock.advance(5 * 60_000);
  return runHealthAlerts(app, config, registry);
}

const sent: DeliveryJob[] = [];
const queue: JobQueue = {
  async createQueue() {},
  async send(_name, data) {
    sent.push(data as unknown as DeliveryJob);
  },
  async work() {},
  async stop() {},
};

let admins: string[];
let teacher: string;

beforeEach(async () => {
  app = await testApp();
  app.clock.set(new Date("2026-10-01T08:00:00.000Z"));
  verdicts = {};
  sent.length = 0;
  openOutbox({ queue, teams: true, log: { error: () => {} } });
  admins = [await seedUser("admin"), await seedUser("admin")];
  teacher = await seedUser("teacher");
});
afterEach(() => closeOutbox());

describe("health.checks — the task in the catalog", () => {
  it("is scheduled every five minutes", () => {
    expect(SCHEDULED_TASKS.find((t) => t.key === "health.checks")).toMatchObject({ defaultIntervalMinutes: 5 });
  });
});

describe("runHealthAlerts", () => {
  it("summarizes the run and keeps each check's state", async () => {
    expect(await run({ backup: { status: "warn", cause: "backup.stale" } })).toBe("2 ok, 1 warn");
    const rows = await app.db.select().from(healthCheckStates);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.key === "backup")).toMatchObject({ status: "warn", consecutive: 1, notifiedStatus: null });
  });

  it("tells each administrator once when a check fails twice in a row, and never a teacher", async () => {
    await run({ disk: LOW_DISK });
    for (const admin of admins) expect(await bellOf(admin)).toEqual([]);

    const summary = await run({ disk: LOW_DISK });
    expect(summary).toBe("2 ok, 1 fail; failing: disk (2 admins told)");
    const expected: NotificationPayload = {
      kind: "system_alert",
      state: "failing",
      checks: ["disk"],
    };
    for (const admin of admins) expect(await bellOf(admin)).toEqual([expected]);
    expect(await bellOf(teacher)).toEqual([]);
    // E-mail on by default, one job per administrator; never Teams.
    expect(sent.map((j) => [j.userId, j.channel]).sort()).toEqual(admins.map((a) => [a, "email"]).sort());

    // Still failing: nothing more, however many runs.
    await run();
    await run();
    for (const admin of admins) expect(await bellOf(admin)).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });

  it("tells of the recovery once", async () => {
    await run({ disk: LOW_DISK });
    await run();
    await run({});
    await run({});
    for (const admin of admins) {
      const bell = await bellOf(admin);
      expect(bell.map((p) => p.kind === "system_alert" && p.state).sort()).toEqual(["failing", "recovered"]);
    }
    expect(await bellOf(teacher)).toEqual([]);
  });

  it("says nothing of a warning, nor of a check it cannot measure", async () => {
    for (let i = 0; i < 3; i++) {
      await run({ backup: { status: "warn", cause: "backup.stale" }, runner: { status: "unknown", cause: "check.failed" } });
    }
    for (const admin of admins) expect(await bellOf(admin)).toEqual([]);
  });

  it("skips an anonymized administrator", async () => {
    const gone = await seedUser("admin", true);
    await run({ runner: { status: "fail", cause: "runner.down" } });
    await run();
    expect(await bellOf(gone)).toEqual([]);
    for (const admin of admins) expect(await bellOf(admin)).toHaveLength(1);
  });

  it("stops reaching an administrator who lost the role: no bell, no e-mail", async () => {
    await run({ disk: LOW_DISK });
    await run();
    const [demoted] = admins;
    await app.db.update(users).set({ role: "teacher" }).where(eq(users.id, demoted!));
    expect(await listNotifications(app.db, demoted!)).toEqual({ items: [], unread: 0 });

    const mails: Mail[] = [];
    const deps: DeliveryDeps = {
      db: app.db,
      webUrl: "https://quiz.test",
      mailer: {
        async send(mail) {
          mails.push(mail);
          return "dry_run";
        },
      },
      teams: null,
      teamsAppId: "",
      tenants: [],
      log: { info: () => {}, warn: () => {} },
    };
    for (const job of sent) await deliver(deps, job);
    // The job queued for the demoted account is dropped; the other admin's goes.
    expect(mails.map((m) => m.to)).toEqual([`${admins[1]}@heig.test`]);
  });

  it("runs the real registry, and the status page says since when a check fails", async () => {
    // No runner mode configured and the test's runner does not answer: the
    // real `runner` check fails.
    await runHealthAlerts(app, config);
    const first = app.clock.now();
    app.clock.advance(5 * 60_000);
    await runHealthAlerts(app, config);
    for (const admin of admins) {
      expect(await bellOf(admin)).toEqual([
        { kind: "system_alert", state: "failing", checks: ["runner"] },
      ]);
    }
    const status = await systemStatus(app, config, { fresh: true });
    const byKey = new Map(status.checks.map((c) => [c.key, c]));
    expect(byKey.get("runner")).toMatchObject({ status: "fail", failingSince: first.toISOString() });
    expect(byKey.get("database")).toMatchObject({ failingSince: null });
  });
});
