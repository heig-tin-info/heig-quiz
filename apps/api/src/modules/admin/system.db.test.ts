/**
 * The system status route (N-OPS-03, F-ADMIN-07, ADR-055) and the coarse
 * words `/healthz` gained, on a real application over PGlite. The route is
 * an administrator's; `/healthz` stays public, narrow, and 200 while the
 * database answers whatever the coarse checks say.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HealthResponse, SYSTEM_CHECK_KEYS, SystemStatus, TestMailResult } from "@quiz/contracts";

import { auditLog } from "../../db/schema.js";
import { resetServiceRecords, tracked } from "../../serviceHealth.js";
import { testServer, type TestServer } from "../../test/http.js";

let server: TestServer;
let dir: string;
let backupFile: string;
type Actor = Awaited<ReturnType<TestServer["signIn"]>>;
let admin: Actor;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "quiz-status-"));
  backupFile = join(dir, "backup-status", "last.json");
  server = await testServer({
    SUPER_ADMIN_EMAIL: "boss@heig.test",
    BACKUP_STATUS_FILE: backupFile,
    COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  });
  admin = await server.signIn("admin", "boss@heig.test");
});

afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

describe("GET /app/api/admin/system", () => {
  it("answers anyone but an administrator as every admin route does", async () => {
    const teacher = await server.signIn("teacher");
    const student = await server.signIn("student");
    const get = (headers?: Record<string, string>) =>
      server.app.inject({ method: "GET", url: "/app/api/admin/system", ...(headers ? { headers } : {}) });
    expect((await get(teacher.headers)).statusCode).toBe(403);
    expect((await get(student.headers)).statusCode).toBe(403);
    expect((await get()).statusCode).toBe(401);
  });

  it("lists every check of the registry, in the contract's shape, and what is deployed", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/app/api/admin/system?fresh=1",
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(200);
    const status = SystemStatus.parse(res.json());
    expect(status.checks.map((c) => c.key)).toEqual([...SYSTEM_CHECK_KEYS]);
    const byKey = new Map(status.checks.map((c) => [c.key, c]));
    // The test server runs no ticker (`WORKER_MODE=web`) and no queue.
    expect(byKey.get("ticker")).toMatchObject({ status: "unknown", cause: "ticker.not_in_process" });
    expect(byKey.get("jobs")).toMatchObject({ status: "warn", cause: "jobs.down" });
    // Configured, but the backup service has not reported yet.
    expect(byKey.get("backup")).toMatchObject({ status: "warn", cause: "backup.missing" });
    expect(byKey.get("offsite")).toMatchObject({ status: "warn", cause: "offsite.missing" });
    expect(status.deployment).toMatchObject({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      workerMode: "web",
      nodeEnv: "test",
    });
    expect(status.deployment.migration).toMatch(/^\d{4}_/);
  });

  it("refuses a malformed query", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/app/api/admin/system?fresh=yes",
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("the services section (ADR-055 §6)", () => {
  it("lists every service, neutral when not configured or not used, never failing for it", async () => {
    resetServiceRecords();
    const res = await server.app.inject({ method: "GET", url: "/app/api/admin/system?fresh=1", headers: admin.headers });
    const byKey = new Map(SystemStatus.parse(res.json()).checks.map((c) => [c.key, c]));
    // No Scaleway credentials in the tests: every mail is a dry run.
    expect(byKey.get("service.mail")).toMatchObject({ section: "services", status: "unknown", cause: "mail.dry_run" });
    expect(byKey.get("service.signin")).toMatchObject({ status: "unknown", cause: "service.unused" });
    for (const key of ["service.teams", "service.llm", "service.github"] as const) {
      expect(byKey.get(key)).toMatchObject({ status: "unknown", cause: "service.not_configured" });
    }
    expect(byKey.get("http.errors")).toMatchObject({ section: "live", status: "ok", value: { kind: "count", n: 0 } });
  });

  it("judges a service from what this process saw of it", async () => {
    resetServiceRecords();
    const failure = Object.assign(new Error("boom"), { status: 502 });
    for (let i = 0; i < 3; i++) await tracked("signin", () => Promise.reject(failure)).catch(() => undefined);
    const res = await server.app.inject({ method: "GET", url: "/app/api/admin/system?fresh=1", headers: admin.headers });
    const signin = SystemStatus.parse(res.json()).checks.find((c) => c.key === "service.signin")!;
    // Failing, but for less than the policy's half hour: a warning.
    expect(signin).toMatchObject({ status: "warn", cause: "service.failed_recently", value: null });
    expect(signin.details).toEqual([
      {
        subject: { kind: "name", name: "http_502" },
        values: [
          { meaning: "lastFailure", value: { kind: "at", iso: expect.any(String) } },
          { meaning: "failed", value: { kind: "count", n: 3 } },
        ],
        cause: null,
      },
    ]);
    resetServiceRecords();
  });
});

describe("POST /app/api/admin/system/test-mail", () => {
  const post = (headers?: Record<string, string>) =>
    server.app.inject({ method: "POST", url: "/app/api/admin/system/test-mail", ...(headers ? { headers } : {}) });

  it("answers anyone but an administrator as every admin route does", async () => {
    expect((await post((await server.signIn("teacher")).headers)).statusCode).toBe(403);
    expect((await post((await server.signIn("student")).headers)).statusCode).toBe(403);
    expect((await post()).statusCode).toBe(401);
  });

  it("sends to the caller (a dry run here), audits it without the address, and refuses a second within the minute", async () => {
    const other = await server.signIn("admin", "second-admin@heig.test");
    const first = await post(other.headers);
    expect(first.statusCode).toBe(200);
    expect(TestMailResult.parse(first.json())).toEqual({ outcome: "dry_run" });

    const again = await post(other.headers);
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ error: "rate_limited" });
    expect(Number(again.headers["retry-after"])).toBeGreaterThan(0);

    const rows = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "system.test_mail"), eq(auditLog.subjectId, other.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: other.id, subjectType: "user", payload: { outcome: "dry_run" } });
    expect(JSON.stringify(rows[0])).not.toContain("second-admin@heig.test");

    // A minute later, on the server's clock, it goes again.
    server.clock.advance(60_001);
    expect((await post(other.headers)).statusCode).toBe(200);
  });
});

describe("GET /metrics (N-OPS-02)", () => {
  it("counts requests by route template, never by a URL carrying an id", async () => {
    const id = randomUUID();
    await server.app.inject({ method: "GET", url: `/app/api/classrooms/${id}`, headers: admin.headers });
    await server.app.inject({ method: "GET", url: `/app/api/nothing-here/${id}`, headers: admin.headers });
    const res = await server.app.inject({ method: "GET", url: "/metrics", headers: admin.headers });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/quiz_http_requests_total\{method="GET",route="\/app\/api\/classrooms\/:\w+",status="4xx"\} 1/);
    expect(res.body).toContain('quiz_http_requests_total{method="GET",route="unmatched",status="4xx"} 1');
    expect(res.body).toContain("quiz_http_request_duration_seconds_bucket");
    expect(res.body).not.toContain(id);
  });
});

describe("/healthz", () => {
  it("gains coarse words only, and stays 200 when a coarse check is bad", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "backup-status"), { recursive: true });
    await writeFile(
      backupFile,
      JSON.stringify({
        finished_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        ok: true,
        exit_code: 0,
        file: "quiz-2026-09-17.dump",
        size_bytes: 4242,
      }),
    );
    const res = await server.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    const body = HealthResponse.parse(res.json());
    expect(body).toMatchObject({
      status: "ok",
      attention: true,
      checks: { database: "up", ticker: "none", backup: "stale" },
    });
    // Nothing of the details: no path, no file name, no size.
    expect(res.body).not.toContain("quiz-2026-09-17");
    expect(res.body).not.toContain("4242");
    expect(res.body).not.toContain(dir);
    expect(Object.keys(body.checks).sort()).toEqual(
      ["backup", "database", "disk", "jobs", "runner", "ticker"],
    );
  });

  it("words the backup as the worse of the dump and its off-site copy", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "backup-status"), { recursive: true });
    const fresh = (file: string) =>
      writeFile(file, JSON.stringify({ finished_at: new Date().toISOString(), ok: true, exit_code: 0 }));
    const word = async () => HealthResponse.parse((await server.app.inject({ method: "GET", url: "/healthz" })).json());
    const offsite = join(dir, "backup-status", "offsite.json");
    await rm(offsite, { force: true });
    await fresh(backupFile);
    // A fresh dump, no off-site report yet: the probe is told.
    expect(await word()).toMatchObject({ attention: true, checks: { backup: "stale" } });
    await fresh(offsite);
    expect(await word()).toMatchObject({ checks: { backup: "ok" } });
  });
});
