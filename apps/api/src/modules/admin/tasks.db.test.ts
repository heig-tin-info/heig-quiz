/**
 * The admin routes of the scheduled tasks (F-ADMIN-05, D10): the list, the
 * configuration and "Run now", on a real application. The test server has
 * no queue (`JOBS_DISABLED=1`), so a run-now runs inline and its outcome is
 * in the response. The rows exist because `buildApp` seeds them at boot.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { AdminScheduledTask, SCHEDULED_TASK_KEYS } from "@quiz/contracts";

import { auditLog, scheduledTasks } from "../../db/schema.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";

let server: TestServer;
type Actor = Awaited<ReturnType<TestServer["signIn"]>>;
let admin: Actor;
let teacher: Actor;
let student: Actor;

beforeAll(async () => {
  server = await testServer({ SUPER_ADMIN_EMAIL: "boss@heig.test" });
  admin = await server.signIn("admin", "boss@heig.test");
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
});

afterAll(async () => {
  await server.close();
});

function call(
  who: Actor | null,
  method: "GET" | "PATCH" | "POST",
  url: string,
  payload?: Payload,
) {
  return server.app.inject({
    method,
    url,
    ...(who ? { headers: who.headers } : {}),
    ...(payload === undefined ? {} : { payload }),
  });
}

async function auditOf(action: "task.configure" | "task.run_now", key: string) {
  return server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.subjectId, key)));
}

describe("the guard", () => {
  it("answers anyone but an administrator as it answers every admin route", async () => {
    for (const [method, url, payload] of [
      ["GET", "/app/api/admin/tasks", undefined],
      ["PATCH", "/app/api/admin/tasks/sessions.purge", { enabled: false }],
      ["POST", "/app/api/admin/tasks/sessions.purge/run", undefined],
    ] as const) {
      expect((await call(teacher, method, url, payload)).statusCode).toBe(403);
      expect((await call(student, method, url, payload)).statusCode).toBe(403);
      expect((await call(null, method, url, payload)).statusCode).toBe(401);
    }
    expect(await auditOf("task.configure", "sessions.purge")).toHaveLength(0);
  });
});

describe("GET /app/api/admin/tasks", () => {
  it("lists the whole catalog, in the contract's shape, and no live task", async () => {
    const res = await call(admin, "GET", "/app/api/admin/tasks");
    expect(res.statusCode).toBe(200);
    const rows = z.array(AdminScheduledTask).parse(res.json());
    expect(rows.map((r) => r.key).sort()).toEqual([...SCHEDULED_TASK_KEYS].sort());
    expect(rows.find((r) => r.key === "drill.purge")).toMatchObject({
      enabled: true,
      intervalMinutes: 360,
      defaultIntervalMinutes: 360,
    });
  });
});

describe("PATCH /app/api/admin/tasks/:key", () => {
  it("answers 404 for a key the catalog does not hold, live ones included", async () => {
    for (const key of ["nope", "live.expire_attempts"]) {
      expect((await call(admin, "PATCH", `/app/api/admin/tasks/${key}`, { enabled: false })).statusCode).toBe(404);
    }
  });

  it("refuses an empty patch, a period out of bounds or not whole, an unknown field", async () => {
    for (const body of [
      {},
      { intervalMinutes: 0 },
      { intervalMinutes: 10_081 },
      { intervalMinutes: 1.5 },
      { enabled: "no" },
      { enabled: true, lastRunAt: null },
    ]) {
      const res = await call(admin, "PATCH", "/app/api/admin/tasks/poll.end_idle", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await auditOf("task.configure", "poll.end_idle")).toHaveLength(0);
  });

  it("changes the period and the activation, audited, and answers the new row", async () => {
    const res = await call(admin, "PATCH", "/app/api/admin/tasks/poll.end_idle", {
      intervalMinutes: 5,
      enabled: false,
    });
    expect(res.statusCode).toBe(200);
    expect(AdminScheduledTask.parse(res.json())).toMatchObject({
      key: "poll.end_idle",
      intervalMinutes: 5,
      defaultIntervalMinutes: 1,
      enabled: false,
      nextRunAt: null,
    });
    const [entry] = await auditOf("task.configure", "poll.end_idle");
    expect(entry).toMatchObject({
      actorUserId: admin.id,
      actorType: "user",
      subjectType: "scheduled_task",
      payload: { intervalMinutes: 5, enabled: false },
    });
  });
});

describe("POST /app/api/admin/tasks/:key/run", () => {
  it("answers 404 for a key the catalog does not hold", async () => {
    expect((await call(admin, "POST", "/app/api/admin/tasks/nope/run")).statusCode).toBe(404);
  });

  it("runs the task inline without a queue (200, the outcome in the answer), audited", async () => {
    const res = await call(admin, "POST", "/app/api/admin/tasks/sessions.purge/run");
    expect(res.statusCode).toBe(200);
    const row = AdminScheduledTask.parse(res.json());
    expect(row).toMatchObject({ key: "sessions.purge", lastStatus: "ok" });
    expect(row.lastMessage).toMatch(/^\d+ expired sessions deleted$/);
    expect(row.lastOkAt).not.toBeNull();
    expect(await auditOf("task.run_now", "sessions.purge")).toHaveLength(1);
  });

  it("refuses a second run while the first one runs (409), and writes no audit for it", async () => {
    // Claimed by a ticker a moment ago, its run still going.
    const running = { lastStatus: "running" as const, lastRunAt: new Date() };
    await server.app.db
      .insert(scheduledTasks)
      .values({ key: "oauth.purge", intervalMinutes: 60, ...running })
      .onConflictDoUpdate({ target: scheduledTasks.key, set: running });
    const res = await call(admin, "POST", "/app/api/admin/tasks/oauth.purge/run");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "task_running" });
    expect(await auditOf("task.run_now", "oauth.purge")).toHaveLength(0);
  });
});
