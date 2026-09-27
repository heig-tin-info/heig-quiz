/**
 * The HTTP surface of the channels (ADR-030) through the real application:
 * the settings, one toggle, and the Teams bot — its messaging endpoint
 * called with tokens signed by a stand-in Bot Framework, Bot Connector
 * replaced by a stub of `fetch`, the only way out of the process.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { NotificationSettings, TeamsLinkPreview } from "@quiz/contracts";

import { auditLog, teamsLinks, teamsLinkTokens } from "../../db/schema.js";
import { fakeBotFramework, type FakeBotFramework } from "../../test/botFramework.js";
import { testServer, type TestServer } from "../../test/http.js";

const APP_ID = "5f0c0a2e-0000-4000-8000-000000000b07";
const SERVICE_URL = "https://smba.trafficmanager.net/emea/";
const TEAMS_ENV = {
  TEAMS_CLIENT_ID: APP_ID,
  TEAMS_CLIENT_SECRET: "client-secret",
  TEAMS_ALLOWED_TENANTS: "tenant-heig",
};
const PREVIEW = "/app/api/notifications/teams/link/preview";

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
    expect(body.teams).toEqual({ available: false, linkedAt: null, teamsName: null });
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
      ["POST", "/app/api/notifications/teams/messages"],
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

describe("with a Teams bot", () => {
  let server: TestServer;
  let bf: FakeBotFramework;
  /** What the bot posted to Bot Connector. */
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  /** The status Bot Connector answers with; 201 unless a test says otherwise. */
  let connectorStatus = 201;

  beforeAll(async () => {
    bf = await fakeBotFramework({ appId: APP_ID, serviceUrl: SERVICE_URL, endorsements: ["msteams"] });
    // The verifier and the Teams client bind `fetch` when the plugin registers.
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const published = bf.answer(url);
      if (published) return published;
      if (url.startsWith("https://login.microsoftonline.com/")) {
        return Response.json({ access_token: "bot-token", expires_in: 3600 });
      }
      if (url.startsWith("https://smba.trafficmanager.net/")) {
        posts.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return new Response("{}", { status: connectorStatus });
      }
      return new Response("unexpected", { status: 599 });
    });
    server = await testServer(TEAMS_ENV);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await server.close();
  });

  function activity(conversationId: string, over: Record<string, unknown> = {}) {
    return {
      type: "installationUpdate",
      action: "add",
      id: "f:1",
      channelId: "msteams",
      serviceUrl: SERVICE_URL,
      locale: "en-US",
      from: { id: "29:user", name: "Léa Rochat", aadObjectId: "aad-lea" },
      recipient: { id: "28:bot", name: "HEIG Quiz" },
      conversation: { id: conversationId, conversationType: "personal", tenantId: "tenant-heig" },
      channelData: { tenant: { id: "tenant-heig" }, source: { name: "message" } },
      entities: [{ type: "clientInfo", locale: "en-US" }],
      ...over,
    };
  }

  async function post(body: unknown, token?: string) {
    return server.app.inject({
      method: "POST",
      url: "/app/api/notifications/teams/messages",
      headers: { authorization: `Bearer ${token ?? (await bf.sign())}`, "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
  }

  /** Installs the app in a fresh chat and returns the token of the card. */
  async function install(): Promise<{ conversation: string; token: string }> {
    const conversation = `a:${randomUUID()}`;
    const before = posts.length;
    expect((await post(activity(conversation))).statusCode).toBe(200);
    expect(posts).toHaveLength(before + 1);
    const card = (posts.at(-1)!.body.attachments as { content: { actions: { url: string }[] } }[])[0]!;
    const url = new URL(card.content.actions[0]!.url);
    expect(url.origin + url.pathname).toBe("http://localhost:3000/teams/link");
    return { conversation, token: url.searchParams.get("token")! };
  }

  it("answers an install with the link card, in the chat Microsoft named", async () => {
    const { conversation } = await install();
    expect(posts.at(-1)!.url).toBe(
      `${SERVICE_URL}v3/conversations/${encodeURIComponent(conversation)}/activities`,
    );
  });

  it("refuses a call without a valid token BEFORE reading the body", async () => {
    const conversation = `a:${randomUUID()}`;
    const before = posts.length;
    for (const token of [
      await bf.sign({ aud: "another-bot" }),
      await bf.sign({}, { key: "rogue" }),
      "garbage",
    ]) {
      const res = await server.app.inject({
        method: "POST",
        url: "/app/api/notifications/teams/messages",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        // Not even JSON: a 401 proves the body was never parsed.
        payload: "{not json",
      });
      expect(res.statusCode).toBe(401);
    }
    const bare = await server.app.inject({
      method: "POST",
      url: "/app/api/notifications/teams/messages",
      payload: activity(conversation),
    });
    expect(bare.statusCode).toBe(401);
    expect(posts).toHaveLength(before);
  });

  it("refuses an activity whose serviceUrl is not the token's, or not a Teams host", async () => {
    const conversation = `a:${randomUUID()}`;
    const before = posts.length;
    const other = await post(activity(conversation, { serviceUrl: "https://smba.trafficmanager.net/amer/" }));
    expect(other.statusCode).toBe(401);
    const evil = "https://evil.example/teams/";
    const outside = await post(activity(conversation, { serviceUrl: evil }), await bf.sign({ serviceurl: evil }));
    expect(outside.statusCode).toBe(403);
    expect(posts).toHaveLength(before);
    expect(await server.app.db.select().from(teamsLinkTokens).where(eq(teamsLinkTokens.conversationId, conversation))).toHaveLength(0);
  });

  it("caps the body of an activity", async () => {
    const res = await post(activity(`a:${randomUUID()}`, { text: "x".repeat(70 * 1024) }));
    expect(res.statusCode).toBe(413);
  });

  it("mints no link for a Teams account of an organization not allowed", async () => {
    const conversation = `a:${randomUUID()}`;
    const before = posts.length;
    const outsider = activity(conversation, {
      conversation: { id: conversation, conversationType: "personal", tenantId: "tenant-elsewhere" },
      channelData: { tenant: { id: "tenant-elsewhere" } },
    });
    expect((await post(outsider)).statusCode).toBe(200);
    expect(posts).toHaveLength(before + 1);
    expect(posts.at(-1)!.body).toMatchObject({ type: "message", textFormat: "plain" });
    expect(posts.at(-1)!.body.attachments).toBeUndefined();
    const tokens = await server.app.db.select().from(teamsLinkTokens).where(eq(teamsLinkTokens.conversationId, conversation));
    expect(tokens).toHaveLength(0);
  });

  it("ignores, with a 200, what it does not serve", async () => {
    const before = posts.length;
    const res = await post(activity(`a:${randomUUID()}`, { conversation: { id: "19:c", conversationType: "channel" } }));
    expect(res.statusCode).toBe(200);
    expect(posts).toHaveLength(before);
  });

  it("previews the link without consuming it, and links once with the CSRF check", async () => {
    const { conversation, token } = await install();
    const me = await server.signIn("student", `lea-${randomUUID()}@heig.test`);

    const anonymous = await server.app.inject({ method: "POST", url: PREVIEW, payload: { token } });
    expect(anonymous.statusCode).toBe(401);
    for (let i = 0; i < 2; i++) {
      const preview = await server.app.inject({ method: "POST", url: PREVIEW, headers: me.headers, payload: { token } });
      expect(preview.statusCode).toBe(200);
      expect(TeamsLinkPreview.parse(preview.json())).toMatchObject({ teamsName: "Léa Rochat", tenantId: "tenant-heig" });
    }

    const { "x-csrf-token": _csrf, ...noCsrf } = me.headers;
    const forged = await server.app.inject({
      method: "POST",
      url: "/app/api/notifications/teams/link",
      headers: noCsrf,
      payload: { token },
    });
    expect(forged.statusCode).toBe(403);

    const before = posts.length;
    const linked = await server.app.inject({
      method: "POST",
      url: "/app/api/notifications/teams/link",
      headers: me.headers,
      payload: { token },
    });
    expect(linked.statusCode).toBe(200);
    expect(NotificationSettings.parse(linked.json()).teams).toMatchObject({ available: true, teamsName: "Léa Rochat" });
    const [row] = await server.app.db.select().from(teamsLinks).where(eq(teamsLinks.userId, me.id));
    expect(row).toMatchObject({ conversationId: conversation, tenantId: "tenant-heig", aadObjectId: "aad-lea" });
    const audited = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "teams.link"), eq(auditLog.subjectId, me.id)));
    expect(audited).toHaveLength(1);
    // The confirmation in Teams comes after the answer, best effort.
    await vi.waitFor(() => expect(posts.length).toBe(before + 1));
    expect(posts.at(-1)!.body).toMatchObject({ type: "message", textFormat: "plain" });

    // Replayed: the token is spent.
    for (const res of [
      await server.app.inject({ method: "POST", url: "/app/api/notifications/teams/link", headers: me.headers, payload: { token } }),
      await server.app.inject({ method: "POST", url: PREVIEW, headers: me.headers, payload: { token } }),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "link_invalid" });
    }
  });

  it("refuses to preview or link through a personal API token", async () => {
    const { token } = await install();
    const me = await server.signIn("teacher");
    const created = await server.app.inject({
      method: "POST",
      url: "/app/api/me/tokens",
      headers: me.headers,
      payload: { name: "script" },
    });
    const bearer = (created.json() as { token?: string }).token;
    expect(bearer).toBeTruthy();
    for (const url of [PREVIEW, "/app/api/notifications/teams/link"]) {
      const res = await server.app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${bearer}` },
        payload: { token },
      });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it("moves a chat linked elsewhere, auditing the unlink of the previous account", async () => {
    const first = await server.signIn("student");
    const second = await server.signIn("student");
    // Two cards for one chat: the install's, and a message's a minute later.
    const { conversation, token: firstCard } = await install();
    server.clock.advance(61_000);
    await post(activity(conversation, { type: "message", text: "link?" }));
    const cards = posts.at(-1)!.body.attachments as { content: { actions: { url: string }[] } }[];
    const secondCard = new URL(cards[0]!.content.actions[0]!.url).searchParams.get("token")!;

    const link = (headers: Record<string, string>, token: string) =>
      server.app.inject({ method: "POST", url: "/app/api/notifications/teams/link", headers, payload: { token } });
    expect((await link(first.headers, firstCard)).statusCode).toBe(200);
    expect((await link(second.headers, secondCard)).statusCode).toBe(200);

    const holders = await server.app.db.select().from(teamsLinks).where(eq(teamsLinks.conversationId, conversation));
    expect(holders.map((l) => l.userId)).toEqual([second.id]);
    const [moved] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "teams.unlink"), eq(auditLog.subjectId, first.id)));
    expect(moved).toMatchObject({ actorUserId: second.id, payload: { via: "moved", to: second.id } });

    // Linked: a message is told to whom, and no token is minted.
    server.clock.advance(61_000);
    const before = await server.app.db.select().from(teamsLinkTokens).where(eq(teamsLinkTokens.conversationId, conversation));
    await post(activity(conversation, { type: "message", text: "who?" }));
    expect(posts.at(-1)!.body).toMatchObject({ type: "message", textFormat: "plain" });
    expect(String(posts.at(-1)!.body.text)).toContain("Test student");
    const after = await server.app.db.select().from(teamsLinkTokens).where(eq(teamsLinkTokens.conversationId, conversation));
    expect(after).toHaveLength(before.length);

    // The app removed from Teams: the link goes, audited as the account's own act.
    await post(activity(conversation, { type: "installationUpdate", action: "remove" }));
    expect(await server.app.db.select().from(teamsLinks).where(eq(teamsLinks.userId, second.id))).toHaveLength(0);
    const [removed] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "teams.unlink"), eq(auditLog.subjectId, second.id)));
    expect(removed).toMatchObject({ actorUserId: second.id, payload: { via: "teams" } });
  });

  it("serves the Teams app package", async () => {
    const res = await server.app.inject({ method: "GET", url: "/app/api/notifications/teams/app.zip" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    const files = unzipSync(res.rawPayload);
    const manifest = JSON.parse(Buffer.from(files["manifest.json"]!).toString("utf8"));
    expect(manifest.id).toBe(APP_ID);
    expect(manifest.bots[0].botId).toBe(APP_ID);
    expect(manifest.validDomains).toEqual(["localhost:3000"]);
  });

  it("disconnects a linked account", async () => {
    const me = await server.signIn("student");
    const { token } = await install();
    await server.app.inject({ method: "POST", url: "/app/api/notifications/teams/link", headers: me.headers, payload: { token } });
    const unlink = await server.app.inject({ method: "DELETE", url: "/app/api/notifications/teams", headers: me.headers });
    expect(NotificationSettings.parse(unlink.json()).teams).toEqual({ available: true, linkedAt: null, teamsName: null });
    const unlinked = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "teams.unlink"), eq(auditLog.subjectId, me.id)));
    expect(unlinked).toHaveLength(1);
  });
});
