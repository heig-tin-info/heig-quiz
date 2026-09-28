/**
 * The HTTP surface of the channels (ADR-030) through the real application:
 * the settings, one toggle, and Teams — the tab's endpoint called with SSO
 * tokens signed by a stand-in Entra (its key served through a stub of
 * `fetch`, the only way out of the process), and the link page.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { NotificationSettings, TeamsLinkPreview, TeamsTabState } from "@quiz/contracts";

import { auditLog, teamsLinks, teamsLinkTokens } from "../../db/schema.js";
import { ENTRA_TENANT, fakeEntra, type FakeEntra } from "../../test/entra.js";
import { testServer, type TestServer } from "../../test/http.js";
import { issueLinkToken } from "./teamsLink.js";

const APP_ID = "31583357-0d89-48ab-8eeb-e9bc49f9e243";
const TEAMS_ENV = {
  TEAMS_CLIENT_ID: APP_ID,
  TEAMS_CLIENT_SECRET: "client-secret",
  TEAMS_ALLOWED_TENANTS: ENTRA_TENANT,
};
const TAB = "/app/api/notifications/teams/tab";
const PREVIEW = "/app/api/notifications/teams/link/preview";
const LINK = "/app/api/notifications/teams/link";

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
    expect(body.teams).toEqual({ available: false, linkedAt: null, teamsName: null, teamsUsername: null });
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
    const unlink = await server.app.inject({ method: "DELETE", url: "/app/api/notifications/teams", headers });
    expect(unlink.statusCode).toBe(503);
    expect(unlink.json()).toEqual({ error: "teams_unavailable" });
    for (const [method, url] of [
      ["POST", "/app/api/notifications/teams/tab"],
      ["GET", "/app/api/notifications/teams/app.zip"],
      ["POST", "/app/api/notifications/teams/link/preview"],
      ["POST", "/app/api/notifications/teams/link"],
    ] as const) {
      const res = await server.app.inject({ method, url, headers, ...(method === "POST" ? { payload: {} } : {}) });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it("requires a session", async () => {
    const res = await server.app.inject({ method: "GET", url: "/app/api/notifications/settings" });
    expect(res.statusCode).toBe(401);
  });
});

describe("with Teams", () => {
  let server: TestServer;
  let entra: FakeEntra;
  /** Every call that left the process. */
  const outbound: string[] = [];

  beforeAll(async () => {
    entra = await fakeEntra({ appId: APP_ID });
    // The verifier binds `fetch` when the plugin registers.
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      outbound.push(url);
      return entra.answer(url) ?? new Response("unexpected", { status: 599 });
    });
    server = await testServer(TEAMS_ENV);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await server.close();
  });

  /** The tab's call, as Teams makes it: the SSO token, no cookie, no body. */
  async function tab(token?: string) {
    return server.app.inject({
      method: "POST",
      url: TAB,
      headers: { authorization: `Bearer ${token ?? (await entra.sign())}` },
    });
  }

  /** A fresh Teams account opens the tab; returns its identity and link token. */
  async function openTab(claims: Record<string, unknown> = {}) {
    const oid = randomUUID();
    const res = await tab(await entra.sign({ oid, ...claims }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const state = TeamsTabState.parse(res.json());
    if (state.state !== "unlinked") throw new Error("expected an unlinked account");
    const url = new URL(state.linkUrl);
    expect(url.origin + url.pathname).toBe("http://localhost:3000/teams/link");
    return { oid, token: url.searchParams.get("token")! };
  }

  const link = (headers: Record<string, string>, token: string) =>
    server.app.inject({ method: "POST", url: LINK, headers, payload: { token } });

  it("gives an unlinked Teams account a link to open in the browser", async () => {
    const { oid, token } = await openTab();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await server.app.db.select().from(teamsLinkTokens).where(eq(teamsLinkTokens.aadObjectId, oid));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: ENTRA_TENANT, teamsUsername: "lea.rochat@heig-vd.ch" });
  });

  it("refuses the tab without a valid SSO token, and says when the organization is not allowed", async () => {
    const before = (await server.app.db.select().from(teamsLinkTokens)).length;
    for (const token of [
      await entra.sign({ aud: "another-api" }),
      await entra.sign({ azp: "00000000-0000-4000-8000-000000000bad" }),
      await entra.sign({}, { key: "rogue" }),
      "garbage",
    ]) {
      const res = await tab(token);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    }
    expect((await server.app.inject({ method: "POST", url: TAB })).statusCode).toBe(401);
    const stranger = await tab(await entra.sign({ tid: "96412a41-a2a2-422e-8438-f29c95c02686" }));
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json()).toEqual({ error: "tenant_not_allowed" });
    expect(await server.app.db.select().from(teamsLinkTokens)).toHaveLength(before);
    // Nothing but Entra's key set was ever fetched.
    expect(outbound.every((url) => url === "https://login.microsoftonline.com/common/discovery/v2.0/keys")).toBe(true);
  });

  it("previews the link without consuming it, and links once with the CSRF check", async () => {
    const { oid, token } = await openTab();
    const me = await server.signIn("student", `lea-${randomUUID()}@heig.test`);

    const anonymous = await server.app.inject({ method: "POST", url: PREVIEW, payload: { token } });
    expect(anonymous.statusCode).toBe(401);
    for (let i = 0; i < 2; i++) {
      const preview = await server.app.inject({ method: "POST", url: PREVIEW, headers: me.headers, payload: { token } });
      expect(preview.statusCode).toBe(200);
      expect(TeamsLinkPreview.parse(preview.json())).toMatchObject({
        teamsName: "Léa Rochat",
        teamsUsername: "lea.rochat@heig-vd.ch",
        tenantId: ENTRA_TENANT,
      });
    }

    const { "x-csrf-token": _csrf, ...noCsrf } = me.headers;
    expect((await link(noCsrf, token)).statusCode).toBe(403);

    const linked = await link(me.headers, token);
    expect(linked.statusCode).toBe(200);
    expect(NotificationSettings.parse(linked.json()).teams).toMatchObject({
      available: true,
      teamsName: "Léa Rochat",
      teamsUsername: "lea.rochat@heig-vd.ch",
    });
    const [row] = await server.app.db.select().from(teamsLinks).where(eq(teamsLinks.userId, me.id));
    expect(row).toMatchObject({ tenantId: ENTRA_TENANT, aadObjectId: oid });
    const audited = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "teams.link"), eq(auditLog.subjectId, me.id)));
    expect(audited).toHaveLength(1);

    // Replayed: the token is spent.
    for (const res of [
      await link(me.headers, token),
      await server.app.inject({ method: "POST", url: PREVIEW, headers: me.headers, payload: { token } }),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "link_invalid" });
    }

    // The tab now says to whom it is linked, and mints nothing.
    const again = await tab(await entra.sign({ oid }));
    expect(TeamsTabState.parse(again.json())).toEqual({ state: "linked", accountName: "Test student" });
    expect(await server.app.db.select().from(teamsLinkTokens).where(eq(teamsLinkTokens.aadObjectId, oid))).toHaveLength(1);
  });

  it("invalidates the previous link each time the tab mints a new one", async () => {
    const { oid, token: first } = await openTab();
    const res = await tab(await entra.sign({ oid }));
    const second = new URL((TeamsTabState.parse(res.json()) as { linkUrl: string }).linkUrl).searchParams.get("token")!;
    const me = await server.signIn("student");
    expect((await server.app.inject({ method: "POST", url: PREVIEW, headers: me.headers, payload: { token: first } })).statusCode).toBe(404);
    expect((await link(me.headers, second)).statusCode).toBe(200);
  });

  it("refuses to preview or link through a personal API token", async () => {
    const { token } = await openTab();
    const me = await server.signIn("teacher");
    const created = await server.app.inject({
      method: "POST",
      url: "/app/api/me/tokens",
      headers: me.headers,
      payload: { name: "script" },
    });
    const bearer = (created.json() as { token?: string }).token;
    expect(bearer).toBeTruthy();
    for (const url of [PREVIEW, LINK]) {
      const res = await server.app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${bearer}` },
        payload: { token },
      });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it("moves a Teams account linked elsewhere, auditing the unlink of the previous account", async () => {
    const first = await server.signIn("student");
    const second = await server.signIn("student");
    const { oid, token } = await openTab();
    expect((await link(first.headers, token)).statusCode).toBe(200);
    // Once linked the tab mints nothing; a token for the same Teams account
    // can still be pending (two tabs racing), and it moves the link.
    const pending = await issueLinkToken(
      server.app.db,
      { tenantId: ENTRA_TENANT, aadObjectId: oid, teamsName: "Léa Rochat", teamsUsername: "lea.rochat@heig-vd.ch" },
      server.clock.now(),
    );
    expect((await link(second.headers, pending)).statusCode).toBe(200);

    const holders = await server.app.db.select().from(teamsLinks).where(eq(teamsLinks.aadObjectId, oid));
    expect(holders.map((l) => l.userId)).toEqual([second.id]);
    const [moved] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "teams.unlink"), eq(auditLog.subjectId, first.id)));
    expect(moved).toMatchObject({ actorUserId: second.id, payload: { via: "moved", to: second.id } });
  });

  it("serves the Teams app package", async () => {
    const res = await server.app.inject({ method: "GET", url: "/app/api/notifications/teams/app.zip" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    const files = unzipSync(res.rawPayload);
    const manifest = JSON.parse(Buffer.from(files["manifest.json"]!).toString("utf8"));
    expect(manifest.id).toBe(APP_ID);
    expect(manifest.webApplicationInfo).toEqual({ id: APP_ID, resource: `api://localhost:3000/${APP_ID}` });
    expect(manifest.staticTabs[0].contentUrl).toBe("http://localhost:3000/teams");
    expect(manifest.validDomains).toEqual(["localhost:3000"]);
    expect(files["fr.json"]).toBeDefined();
  });

  it("disconnects a linked account", async () => {
    const me = await server.signIn("student");
    const { token } = await openTab();
    await link(me.headers, token);
    const unlink = await server.app.inject({ method: "DELETE", url: "/app/api/notifications/teams", headers: me.headers });
    expect(NotificationSettings.parse(unlink.json()).teams).toEqual({
      available: true,
      linkedAt: null,
      teamsName: null,
      teamsUsername: null,
    });
    const unlinked = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "teams.unlink"), eq(auditLog.subjectId, me.id)));
    expect(unlinked).toHaveLength(1);
  });
});
