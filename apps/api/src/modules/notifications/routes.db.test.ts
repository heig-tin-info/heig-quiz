/**
 * The HTTP surface of the channels (ADR-030) through the real application:
 * the settings, one toggle, and the Teams link with Microsoft replaced by a
 * stub of `fetch` — the only way in from outside the process.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { NotificationSettings } from "@quiz/contracts";

import { auditLog, teamsLinks } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";

const TEAMS_ENV = {
  TEAMS_CLIENT_ID: "client-id",
  TEAMS_CLIENT_SECRET: "client-secret",
  TEAMS_APP_ID: "teams-app",
};

/** The cookies a response sets, as a `cookie` request header fragment. */
function cookiesOf(setCookie: string | string[] | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.map((c) => c.split(";")[0]).join("; ");
}

describe("without a Teams application", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await testServer();
  });
  afterAll(() => server.close());

  it("serves the settings and says Teams is not available", async () => {
    const { headers } = await server.signIn("student", "sam@heig.test");
    const res = await server.app.inject({ method: "GET", url: "/app/api/notifications/settings", headers });
    expect(res.statusCode).toBe(200);
    const body = NotificationSettings.parse(res.json());
    expect(body.email).toBe("sam@heig.test");
    expect(body.teams).toEqual({ available: false, linkedAt: null });
    expect(body.matrix.results_released).toEqual({ bell: true, email: true, teams: true });
  });

  it("stores one toggle and refuses a kind or channel it does not know", async () => {
    const { headers } = await server.signIn("teacher");
    const put = (payload: unknown) =>
      server.app.inject({ method: "PUT", url: "/app/api/notifications/preferences", headers, payload });
    const ok = await put({ kind: "pool_shared", channel: "email", enabled: false });
    expect(ok.statusCode).toBe(200);
    expect(NotificationSettings.parse(ok.json()).matrix.pool_shared.email).toBe(false);
    expect((await put({ kind: "nope", channel: "email", enabled: false })).statusCode).toBe(400);
    expect((await put({ kind: "pool_shared", channel: "sms", enabled: false })).statusCode).toBe(400);
    // The CSRF check applies like on every write.
    const { "x-csrf-token": _csrf, ...noCsrf } = headers;
    const forged = await server.app.inject({
      method: "PUT",
      url: "/app/api/notifications/preferences",
      headers: noCsrf,
      payload: { kind: "pool_shared", channel: "email", enabled: true },
    });
    expect(forged.statusCode).toBe(403);
  });

  it("answers the Teams routes cleanly", async () => {
    const { headers } = await server.signIn("teacher");
    const connect = await server.app.inject({
      method: "POST",
      url: "/app/api/notifications/teams/connect",
      headers,
    });
    expect(connect.statusCode).toBe(503);
    expect(connect.json()).toEqual({ error: "teams_unavailable" });
    const unlink = await server.app.inject({ method: "DELETE", url: "/app/api/notifications/teams", headers });
    expect(unlink.statusCode).toBe(503);
    const callback = await server.app.inject({
      method: "GET",
      url: "/app/api/notifications/teams/callback?code=x&state=y",
      headers,
    });
    expect(callback.statusCode).toBe(404);
  });

  it("requires a session", async () => {
    const res = await server.app.inject({ method: "GET", url: "/app/api/notifications/settings" });
    expect(res.statusCode).toBe(401);
  });
});

describe("with a Teams application", () => {
  let server: TestServer;
  const idTokenFor = (nonce: string) => {
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${part({ alg: "none" })}.${part({
      aud: "client-id",
      nonce,
      tid: "tenant-1",
      oid: "object-1",
      iss: "https://login.microsoftonline.com/tenant-1/v2.0",
    })}.`;
  };
  /** The nonce of the attempt in flight: Microsoft echoes it into the ID token. */
  let nonce = "";

  beforeAll(async () => {
    // The Teams client binds `fetch` when the plugin registers it.
    vi.stubGlobal("fetch", async (input: string | URL) => {
      if (String(input).endsWith("/organizations/oauth2/v2.0/token")) {
        return new Response(JSON.stringify({ id_token: idTokenFor(nonce), access_token: "dropped" }), {
          status: 200,
        });
      }
      return new Response("unexpected", { status: 599 });
    });
    server = await testServer(TEAMS_ENV);
  });
  afterEach(() => {
    nonce = "";
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await server.close();
  });

  async function connect(headers: Record<string, string>) {
    const res = await server.app.inject({
      method: "POST",
      url: "/app/api/notifications/teams/connect",
      headers,
    });
    expect(res.statusCode).toBe(200);
    const url = new URL((res.json() as { url: string }).url);
    nonce = url.searchParams.get("nonce")!;
    return { url, stash: cookiesOf(res.headers["set-cookie"]) };
  }

  it("links the account through Microsoft, audits it, and unlinks it", async () => {
    const me = await server.signIn("student");
    const { url, stash } = await connect(me.headers);
    expect(url.host).toBe("login.microsoftonline.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/app/api/notifications/teams/callback",
    );

    const back = await server.app.inject({
      method: "GET",
      url: `/app/api/notifications/teams/callback?code=abc&state=${url.searchParams.get("state")}`,
      headers: { cookie: `${me.headers.cookie}; ${stash}` },
    });
    expect(back.statusCode).toBe(303);
    expect(back.headers.location).toBe("/settings?teams=linked");

    const [link] = await server.app.db.select().from(teamsLinks).where(eq(teamsLinks.userId, me.id));
    expect(link).toMatchObject({ tenantId: "tenant-1", objectId: "object-1", chatId: null });
    const linked = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "teams.link"), eq(auditLog.subjectId, me.id)));
    expect(linked).toHaveLength(1);

    const settings = await server.app.inject({
      method: "GET",
      url: "/app/api/notifications/settings",
      headers: me.headers,
    });
    expect(NotificationSettings.parse(settings.json()).teams.linkedAt).not.toBeNull();

    const unlink = await server.app.inject({
      method: "DELETE",
      url: "/app/api/notifications/teams",
      headers: me.headers,
    });
    expect(NotificationSettings.parse(unlink.json()).teams).toEqual({ available: true, linkedAt: null });
    const unlinked = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "teams.unlink"), eq(auditLog.subjectId, me.id)));
    expect(unlinked).toHaveLength(1);
  });

  it("refuses a callback with a wrong state, without the stash, or for another account", async () => {
    const me = await server.signIn("teacher");
    const other = await server.signIn("teacher");
    const { url, stash } = await connect(me.headers);
    const state = url.searchParams.get("state")!;
    const attempts = [
      { url: `?code=abc&state=forged`, cookie: `${me.headers.cookie}; ${stash}` },
      { url: `?code=abc&state=${state}`, cookie: me.headers.cookie },
      { url: `?code=abc&state=${state}`, cookie: `${other.headers.cookie}; ${stash}` },
      { url: `?error=access_denied&state=${state}`, cookie: `${me.headers.cookie}; ${stash}` },
      { url: `?code=abc&state=${state}`, cookie: stash },
    ];
    for (const attempt of attempts) {
      const res = await server.app.inject({
        method: "GET",
        url: `/app/api/notifications/teams/callback${attempt.url}`,
        headers: { cookie: attempt.cookie! },
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/settings?teams=error");
    }
    const links = await server.app.db.select().from(teamsLinks);
    expect(links.map((l) => l.userId)).not.toContain(me.id);
    expect(links.map((l) => l.userId)).not.toContain(other.id);
  });
});
