/**
 * The system status route (N-OPS-03, F-ADMIN-07, ADR-055) and the coarse
 * words `/healthz` gained, on a real application over PGlite. The route is
 * an administrator's; `/healthz` stays public, narrow, and 200 while the
 * database answers whatever the coarse checks say.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HealthResponse, SYSTEM_CHECK_KEYS, SystemStatus } from "@quiz/contracts";

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
});
