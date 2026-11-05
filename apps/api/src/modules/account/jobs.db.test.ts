/**
 * The `accounts.lifecycle` task (ADR-117 §3, §4, §10; product owner,
 * 2026-11-05) against the real migrations: the notice once, to both
 * addresses when they differ, at most fifty a run and only once the queue
 * took the e-mail; the reminder nine months later; the pseudonymization
 * twelve months after the notice; a sign-in, or any use, that ends the
 * dormancy; staff accounts left alone; the System status's `accounts` check
 * (the cap's backlog, an account late, nothing while the flag is off);
 * nothing at all while `ACCOUNT_LIFECYCLE` is off. The inactivity is set in
 * the database's clock, as the task reads it. The words of the e-mail are
 * `notifications/templates.test.ts`'s.
 */
import { randomUUID } from "node:crypto";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationPayload } from "@quiz/contracts";

import { SYSTEM_ACTOR } from "../../audit.js";
import { signIn } from "../../auth/login.js";
import { loadConfig, type AppConfig } from "../../config.js";
import { auditLog, notifications, users } from "../../db/schema.js";
import type { JobQueue } from "../../jobs.js";
import { testApp, testDatabase } from "../../test/db.js";
import { deliver, type DeliveryDeps } from "../notifications/jobs.js";
import type { Mail } from "../notifications/mailer.js";
import { closeOutbox, openOutbox, type DeliveryJob } from "../notifications/outbox.js";
import { preferenceMatrix, setPreference } from "../notifications/service.js";
import { rosterRefusal } from "../org/errors.js";
import * as org from "../org/service.js";
import { runHealthAlerts } from "../system/alerts.js";
import { HEALTH_CHECKS } from "../system/health.js";
import { ACCOUNT_TASKS } from "./jobs.js";
import { LIFECYCLE, pseudonymizeUser } from "./service.js";

vi.mock("../org/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../org/service.js")>();
  return { ...actual, revokeAccountAccess: vi.fn(actual.revokeAccountAccess) };
});

// No GitHub App: a revocation has nothing to revoke, unless the test says it fails.
const config = loadConfig({ NODE_ENV: "test", ACCOUNT_LIFECYCLE: "1" });
const off = { ...config, ACCOUNT_LIFECYCLE: false } as AppConfig;

let app: Awaited<ReturnType<typeof testApp>>;
let pg: PGlite;
const exec = (sql: string, params: unknown[] = []) => pg.query(sql, params);

const sent: DeliveryJob[] = [];
let queueDown = false;
const queue: JobQueue = {
  async createQueue() {},
  async send(_name, data) {
    if (queueDown) throw new Error("queue down");
    sent.push(data as unknown as DeliveryJob);
  },
  async work() {},
  async stop() {},
};

beforeAll(async () => {
  const handle = await testDatabase();
  pg = handle.client;
  app = await testApp(handle.db);
});

beforeEach(async () => {
  // Every account of a previous test leaves the lifecycle's sight.
  await exec(`UPDATE users SET anonymized_at = now() WHERE anonymized_at IS NULL`);
  sent.length = 0;
  queueDown = false;
  openOutbox({ queue, teams: false, log: { error: () => {} } });
});

afterEach(() => closeOutbox());

/** One run of the task, as the ticker calls it. */
async function run(cfg: AppConfig = config): Promise<string> {
  return (await ACCOUNT_TASKS[0]!.run(app, cfg)) as string;
}

/** The System status's `accounts` check. */
const check = (cfg: AppConfig = config) => HEALTH_CHECKS.find((c) => c.key === "accounts")!.run({ app, config: cfg, now: new Date() });

/**
 * A student account whose only trace is its creation, `idle` ago (a
 * PostgreSQL interval); `notification`: a second verified address chosen
 * for its notifications.
 */
async function student(idle: string, options: { notification?: string; locale?: string } = {}): Promise<string> {
  const id = randomUUID();
  const email = `s-${id.slice(0, 8)}@heig-vd.ch`;
  await exec(
    `INSERT INTO users (id, oidc_sub, email, given_name, family_name, role, locale, created_at)
     VALUES ($1, $2, $3, 'Ada', 'Lovelace', 'student', $4, now() - $5::interval)`,
    [id, `sub-${id}`, email, options.locale ?? null, idle],
  );
  await exec(`INSERT INTO user_emails (user_id, email, source, verified) VALUES ($1, $2, 'login', true)`, [id, email]);
  if (options.notification) {
    await exec(`INSERT INTO user_emails (user_id, email, source, verified) VALUES ($1, $2, 'mail', true)`, [id, options.notification]);
    await exec(`UPDATE users SET notification_email = $2 WHERE id = $1`, [id, options.notification]);
  }
  return id;
}

/** Dormant since `notice` ago, reminded `reminder` ago when given. */
async function dormant(userId: string, notice: string, reminder?: string): Promise<void> {
  await exec(
    `UPDATE users SET inactivity_notified_at = now() - $2::interval,
       inactivity_reminded_at = CASE WHEN $3::interval IS NULL THEN NULL ELSE now() - $3::interval END WHERE id = $1`,
    [userId, notice, reminder ?? null],
  );
}

/** Due for pseudonymization: notice a year and a day ago, reminder three months and a day ago. */
const due = (userId: string) => dormant(userId, "12 months 1 day", "3 months 1 day");

async function admin(): Promise<string> {
  const id = randomUUID();
  await exec(`INSERT INTO users (id, oidc_sub, email, role) VALUES ($1, $2, $3, 'admin')`, [id, `sub-${id}`, `${id}@heig.test`]);
  return id;
}

async function row(userId: string) {
  const [user] = await app.db.select().from(users).where(eq(users.id, userId));
  return user!;
}

/** The e-mails the queued jobs send, through the real delivery job and a fake mailer. */
async function mails(): Promise<Mail[]> {
  const out: Mail[] = [];
  const deps: DeliveryDeps = {
    db: app.db,
    webUrl: "https://quiz.test",
    mailer: {
      async send(mail) {
        out.push(mail);
        return "dry_run";
      },
    },
    teams: null,
    teamsAppId: "",
    tenants: [],
    log: { info: () => {}, warn: () => {} },
  };
  for (const job of sent) await deliver(deps, job);
  return out;
}

const pseudonymized = async (userId: string) =>
  (await app.db.select().from(auditLog).where(eq(auditLog.subjectId, userId))).filter((e) => e.action === "user.anonymized");

const bellOf = async (userId: string) =>
  (await app.db.select().from(notifications).where(eq(notifications.userId, userId))).map((n) => NotificationPayload.parse(n.payload));

describe("the notice", () => {
  it("goes once to an account two years idle, to both addresses when they differ, in its language", async () => {
    const two = await student("2 years 1 day", { notification: "ada.private@example.org", locale: "fr" });
    const fresh = await student("23 months");

    expect(await run()).toContain("1 notified");
    expect((await row(two)).inactivityNotifiedAt).not.toBeNull();
    expect((await row(fresh)).inactivityNotifiedAt).toBeNull();
    expect(sent.map((job) => [job.userId, job.channel, job.payload])).toEqual([[two, "email", { kind: "account_dormant", state: "notice" }]]);
    const out = await mails();
    expect(out.map((mail) => mail.to).sort()).toEqual(["ada.private@example.org", (await row(two)).email].sort());
    for (const mail of out) expect(mail.subject).toMatch(/^Votre compte HEIG Quiz/);
    // An e-mail only: nothing in the bell.
    expect(await bellOf(two)).toEqual([]);

    sent.length = 0;
    expect(await run()).toContain("0 notified");
    expect(sent).toEqual([]);
  });

  it("sends one e-mail when the notification address is the login address", async () => {
    const one = await student("3 years");
    await run();
    expect((await mails()).map((mail) => mail.to)).toEqual([(await row(one)).email]);
  });

  it("marks nobody whose e-mail the queue refused", async () => {
    const untold = await student("3 years");
    queueDown = true;
    expect(await run()).toContain("0 notified");
    expect((await row(untold)).inactivityNotifiedAt).toBeNull();
    queueDown = false;
    expect(await run()).toContain("1 notified");
  });

  it("tells at most fifty a run, the longest unused first", async () => {
    const ids: string[] = [];
    for (let i = 0; i <= LIFECYCLE.noticesPerRun; i++) ids.push(await student(`${3 * 365 - i} days`));
    expect(await run()).toContain(`${LIFECYCLE.noticesPerRun} notified`);
    const untold = [];
    for (const id of ids) if ((await row(id)).inactivityNotifiedAt === null) untold.push(id);
    expect(untold).toEqual([ids.at(-1)]);
    expect(await run()).toContain("1 notified");
  });

  it("goes whatever toggle a stored preference row says, and the grid shows none", async () => {
    const stubborn = await student("3 years");
    // A row the route refuses (the contract), written behind its back.
    await setPreference(app.db, stubborn, { kind: "account_dormant", channel: "email", enabled: false });
    expect((await preferenceMatrix(app.db, stubborn)).account_dormant).toEqual({ bell: false, email: true, teams: false });
    await run();
    expect(sent.map((job) => job.userId)).toEqual([stubborn]);
  });
});

describe("the reminder and the pseudonymization", () => {
  it("reminds at nine months, once, and pseudonymizes at twelve", async () => {
    const ada = await student("4 years");
    await dormant(ada, "8 months");
    await run();
    expect((await row(ada)).inactivityRemindedAt).toBeNull();

    await dormant(ada, "9 months 1 day");
    expect(await run()).toContain("1 reminded");
    expect(sent.map((job) => job.payload)).toEqual([{ kind: "account_dormant", state: "reminder" }]);
    sent.length = 0;
    await run();
    expect(sent).toEqual([]);
    expect(await pseudonymized(ada)).toEqual([]);

    await due(ada);
    expect(await run()).toContain("1 pseudonymized");
    expect((await pseudonymized(ada)).map((e) => e.payload)).toEqual([{ userId: ada, by: "lifecycle" }]);
    const gone = await row(ada);
    expect(gone.anonymizedAt).not.toBeNull();
    expect([gone.givenName, gone.email]).toEqual(["Anonymous", `anon-${ada}@example.invalid`]);
  });

  it("never pseudonymizes right after a reminder a paused task sent late", async () => {
    const late = await student("4 years");
    await dormant(late, "14 months");
    expect(await run()).toContain("1 reminded");
    expect(await pseudonymized(late)).toEqual([]);
  });

  it("does nothing once a sign-in ended the dormancy", async () => {
    const back = await student("4 years");
    await due(back);
    const user = await row(back);
    await signIn(app.db, config, {
      sub: user.oidcSub,
      email: user.email,
      emailVerified: true,
      givenName: "Ada",
      familyName: "Lovelace",
      swissEduId: null,
      picture: null,
      raw: {},
      complete: true,
    });
    const after = await row(back);
    expect([after.inactivityNotifiedAt, after.inactivityRemindedAt]).toEqual([null, null]);
    await run();
    expect(sent).toEqual([]);
    expect(await pseudonymized(back)).toEqual([]);
  });

  it("makes active again an account used since its notice without signing in", async () => {
    const used = await student("4 years");
    await due(used);
    await exec(`INSERT INTO presence_last_seen (user_id, at) VALUES ($1, now() - interval '1 day')`, [used]);
    expect(await run()).toContain("1 active again");
    expect((await row(used)).inactivityNotifiedAt).toBeNull();
    expect(await pseudonymized(used)).toEqual([]);
  });

  it("refuses a token used between the selection and the lock: not due", async () => {
    const racing = await student("4 years");
    await due(racing);
    vi.mocked(org.revokeAccountAccess).mockImplementationOnce(async () => {
      await exec(
        `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, last_used_at) VALUES ($1, $2, 'cli', $3, 'q_', 'quiz', now())`,
        [randomUUID(), racing, randomUUID().replace(/-/g, "").padEnd(64, "0")],
      );
    });
    await expect(
      pseudonymizeUser(app.db, racing, { by: "lifecycle", actor: SYSTEM_ACTOR, config, log: app.log, now: new Date() }),
    ).rejects.toMatchObject({ code: "not_due" });
    expect((await row(racing)).anonymizedAt).toBeNull();
  });

  it("neither notifies nor pseudonymizes a staff account", async () => {
    const teacher = await student("5 years");
    await exec(`INSERT INTO teacher_grants (id, email, created_by) VALUES ($1, $2, $3)`, [randomUUID(), (await row(teacher)).email, teacher]);
    await run();
    expect(sent).toEqual([]);
    expect((await row(teacher)).inactivityNotifiedAt).toBeNull();
  });

  it("wakes an account that became staff after its reminder: dates cleared, check ok, nothing anonymized", async () => {
    const assistant = await student("5 years");
    await due(assistant);
    const pool = randomUUID();
    await exec(`INSERT INTO pools (id, name, owner_id) VALUES ($1, 'Réseaux', $2)`, [pool, await admin()]);
    await exec(`INSERT INTO pool_members (pool_id, user_id, role) VALUES ($1, $2, 'reader')`, [pool, assistant]);
    expect(await run()).toContain("0 skipped, 1 active again");
    const after = await row(assistant);
    expect([after.inactivityNotifiedAt, after.inactivityRemindedAt, after.anonymizedAt]).toEqual([null, null, null]);
    expect(await pseudonymized(assistant)).toEqual([]);
    expect(await check()).toMatchObject({ status: "ok" });
  });
});

describe("the System status's accounts check", () => {
  it("fails on more due than one run takes; the run takes twenty, the oldest notices first", async () => {
    const watcher = await admin();
    const ids: string[] = [];
    for (let i = 0; i < LIFECYCLE.perRun + 1; i++) {
      const id = await student("4 years");
      await dormant(id, `12 months ${i + 1} days`, "3 months 1 day");
      ids.push(id);
    }
    expect(await check()).toMatchObject({ status: "fail", cause: "accounts.backlog", value: { kind: "count", n: 21 } });

    expect(await run()).toContain(`${LIFECYCLE.perRun} pseudonymized, 0 skipped`);
    const left = [];
    for (const id of ids) if ((await row(id)).anonymizedAt === null) left.push(id);
    expect(left).toEqual([ids[0]]);
    expect(await check()).toMatchObject({ status: "ok", value: { kind: "count", n: 1 } });
    // One alert path: the check's, never the run's.
    expect(await bellOf(watcher)).toEqual([]);
  });

  it("fails on an account still due three days past its term, and the health task tells the administrators", async () => {
    const watcher = await admin();
    const stuck = await student("4 years");
    await due(stuck);
    vi.mocked(org.revokeAccountAccess).mockRejectedValueOnce(rosterRefusal("revoke_failed", { repo: "heig/lab-x" }));
    expect(await run()).toContain("1 skipped");
    expect(await check()).toMatchObject({ status: "ok" });

    await dormant(stuck, "12 months 4 days", "3 months 4 days");
    expect(await check()).toMatchObject({ status: "fail", cause: "accounts.late", value: { kind: "count", n: 1 } });
    const accounts = HEALTH_CHECKS.filter((c) => c.key === "accounts");
    await runHealthAlerts(app, config, accounts);
    await runHealthAlerts(app, config, accounts);
    expect(await bellOf(watcher)).toEqual([{ kind: "system_alert", state: "failing", checks: ["accounts"] }]);

    // GitHub takes it the next day: pseudonymized, the account leaves the check.
    expect(await run()).toContain("1 pseudonymized");
    expect(await check()).toMatchObject({ status: "ok" });
  });

  it("says nothing while ACCOUNT_LIFECYCLE is off, whatever the dates", async () => {
    const copied = await student("4 years");
    await dormant(copied, "2 years", "1 year");
    expect(await check()).toMatchObject({ status: "fail" });
    expect(await check(off)).toEqual({ status: "ok" });
  });
});

describe("ACCOUNT_LIFECYCLE=0", () => {
  it("does nothing at all", async () => {
    const idle = await student("5 years");
    const waiting = await student("5 years");
    await due(waiting);
    expect(await run(off)).toBe("off (ACCOUNT_LIFECYCLE=0)");
    expect(sent).toEqual([]);
    expect((await row(idle)).inactivityNotifiedAt).toBeNull();
    expect(await pseudonymized(waiting)).toEqual([]);
  });
});
