/**
 * Personal API tokens over the REAL application (ADR-022): minted by a
 * session, used as a bearer, refused once revoked or expired, and never able
 * to manage tokens themselves.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_TOKEN_PREFIX, type ApiToken, type ApiTokenCreated } from "@quiz/contracts";

import { apiTokens, auditLog } from "../db/schema.js";
import { createApiToken } from "./tokens.js";
import { type Payload, testServer, type TestServer } from "../test/http.js";

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
});
afterAll(() => server.close());

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function mint(headers: Record<string, string>, body: Payload = { name: "Claude" }) {
  const res = await server.app.inject({ method: "POST", url: "/app/api/me/tokens", headers, payload: body });
  return { status: res.statusCode, body: res.json() as ApiTokenCreated };
}

describe("minting and listing", () => {
  it("hands the secret out once and stores only its hash", async () => {
    const { status, body } = await mint(teacher.headers);
    expect(status).toBe(201);
    expect(body.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(body.token.startsWith(body.prefix)).toBe(true);
    // 90 days by default.
    expect(new Date(body.expiresAt!).getTime() - server.clock.now().getTime()).toBe(90 * 86_400_000);

    const [row] = await server.app.db.select().from(apiTokens).where(eq(apiTokens.id, body.id));
    expect(JSON.stringify(row)).not.toContain(body.token);

    const list = await server.app.inject({ method: "GET", url: "/app/api/me/tokens", headers: teacher.headers });
    const tokens = list.json() as ApiToken[];
    expect(tokens.map((t) => t.id)).toContain(body.id);
    expect(list.body).not.toContain(body.token);
  });

  it("is a teacher's tool: a student cannot mint one", async () => {
    const student = await server.signIn("student");
    expect((await mint(student.headers)).status).toBe(403);
  });

  it("validates the body with the contract", async () => {
    expect((await mint(teacher.headers, { name: "" })).status).toBe(400);
    expect((await mint(teacher.headers, { name: "x", expiresInDays: 7 })).status).toBe(400);
    expect((await mint(teacher.headers, { name: "x", scope: "admin" })).status).toBe(400);
  });

  it("is scoped to MCP by default, lists its scope and audits it (ADR-113)", async () => {
    const { body } = await mint(teacher.headers);
    expect(body.scope).toBe("quiz");
    const read = await mint(teacher.headers, { name: "reader", scope: "quiz:read" });
    expect(read.status).toBe(201);
    const list = (await server.app.inject({ method: "GET", url: "/app/api/me/tokens", headers: teacher.headers })).json() as ApiToken[];
    expect(list.find((t) => t.id === read.body.id)?.scope).toBe("quiz:read");
    const [entry] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "api_token.create"), eq(auditLog.subjectId, read.body.id)));
    expect(entry!.payload).toMatchObject({ scope: "quiz:read" });
  });

  it("refuses a full API token that never expires (ADR-113 §1)", async () => {
    const endless = await mint(teacher.headers, { name: "cli", scope: "api", expiresInDays: null });
    expect(endless.status).toBe(422);
    expect(endless.body).toMatchObject({ error: "token_expiry_required" });
    expect((await mint(teacher.headers, { name: "cli", scope: "api", expiresInDays: 365 })).status).toBe(201);
    expect((await mint(teacher.headers, { name: "mcp", scope: "quiz", expiresInDays: null })).status).toBe(201);
  });

  it("holds a scope on every personal row, and none on an audience-bound one (the CHECKs)", async () => {
    const row = (over: Partial<typeof apiTokens.$inferInsert>) =>
      server.app.db.insert(apiTokens).values({
        id: randomUUID(),
        userId: teacher.id,
        name: "raw",
        tokenHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
        prefix: "quiz_pat_raw",
        ...over,
      });
    await expect(row({})).rejects.toThrow();
    await expect(row({ audience: "urn:quiz:assist", scope: "quiz" })).rejects.toThrow();
    await expect(row({ scope: "everything" as never })).rejects.toThrow();
    await expect(row({ scope: "quiz:read" })).resolves.toBeDefined();
  });
});

describe("using a token", () => {
  it("authenticates a read and a write, without CSRF, audited as api_key", async () => {
    const { body } = await mint(teacher.headers, { name: "script", scope: "api" });
    const list = await server.app.inject({ method: "GET", url: "/app/api/courses", headers: bearer(body.token) });
    expect(list.statusCode).toBe(200);

    const created = await server.app.inject({
      method: "POST",
      url: "/app/api/pools",
      headers: bearer(body.token),
      payload: { name: "Pool by token" },
    });
    expect(created.statusCode).toBe(201);
    const poolId = created.json().id as string;
    const [entry] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "pool.create"), eq(auditLog.subjectId, poolId)));
    expect(entry).toMatchObject({ actorType: "api_key", actorUserId: teacher.id });

    const [row] = await server.app.db.select().from(apiTokens).where(eq(apiTokens.id, body.id));
    expect(row!.lastUsedAt).not.toBeNull();
  });

  it("cannot manage tokens: that takes a browser session", async () => {
    const { body } = await mint(teacher.headers);
    for (const [method, url] of [
      ["GET", "/app/api/me/tokens"],
      ["POST", "/app/api/me/tokens"],
      ["DELETE", `/app/api/me/tokens/${body.id}`],
    ] as const) {
      const res = await server.app.inject({ method, url, headers: bearer(body.token), payload: { name: "again" } });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("is the whole credential: a bad bearer does not fall back to the cookie", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/app/api/courses",
      headers: { ...teacher.headers, authorization: `Bearer ${API_TOKEN_PREFIX}not-a-real-token` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("is refused once revoked", async () => {
    const { body } = await mint(teacher.headers);
    const revoked = await server.app.inject({
      method: "DELETE",
      url: `/app/api/me/tokens/${body.id}`,
      headers: teacher.headers,
    });
    expect(revoked.statusCode).toBe(200);
    expect((revoked.json() as ApiToken).revokedAt).not.toBeNull();
    const res = await server.app.inject({ method: "GET", url: "/app/api/courses", headers: bearer(body.token) });
    expect(res.statusCode).toBe(401);
  });

  it("is refused once expired", async () => {
    const { body } = await mint(teacher.headers, { name: "short", expiresInDays: 30, scope: "api" });
    const ok = await server.app.inject({ method: "GET", url: "/app/api/courses", headers: bearer(body.token) });
    expect(ok.statusCode).toBe(200);
    server.clock.advance(31 * 86_400_000);
    const res = await server.app.inject({ method: "GET", url: "/app/api/courses", headers: bearer(body.token) });
    expect(res.statusCode).toBe(401);
  });

  it("reaches the administration only if it expires (audit L6)", async () => {
    const admin = await server.signIn("admin");
    const usersOf = (token: string) =>
      server.app.inject({ method: "GET", url: "/app/api/admin/users", headers: bearer(token) });

    // An administrator mints none that never expires…
    const endless = await mint(admin.headers, { name: "forever", expiresInDays: null });
    expect(endless.status).toBe(422);
    expect(endless.body).toMatchObject({ error: "token_expiry_required" });
    // …and one made before the rule is refused there, while the rest of the API still takes it.
    const old = await createApiToken(server.app.db, admin.id, { name: "old", expiresInDays: null, scope: "api" }, server.clock.now());
    const refused = await usersOf(old.token);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "token_expiry_required" });
    const courses = await server.app.inject({ method: "GET", url: "/app/api/courses", headers: bearer(old.token) });
    expect(courses.statusCode).toBe(200);

    // A token that expires reaches it.
    const { status, body } = await mint(admin.headers, { name: "monthly", expiresInDays: 30, scope: "api" });
    expect(status).toBe(201);
    expect((await usersOf(body.token)).statusCode).toBe(200);

    // A teacher's endless token is theirs to keep — an MCP one (ADR-113) —
    // and one made before the scopes meets the role's 403 there.
    const own = await mint(teacher.headers, { name: "forever", expiresInDays: null });
    expect(own.status).toBe(201);
    const legacy = await createApiToken(server.app.db, teacher.id, { name: "old", expiresInDays: null, scope: "api" });
    expect((await usersOf(legacy.token)).json()).toEqual({ error: "forbidden" });
  });

  it("cannot be revoked by someone else: 404, like a token that never existed", async () => {
    const { body } = await mint(teacher.headers);
    const other = await server.signIn("teacher");
    const res = await server.app.inject({
      method: "DELETE",
      url: `/app/api/me/tokens/${body.id}`,
      headers: other.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});
