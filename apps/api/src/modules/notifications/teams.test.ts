import { describe, expect, it } from "vitest";

import { allowedServiceUrl, createTeamsClient, TeamsError } from "./teams.js";

const config = {
  TEAMS_CLIENT_ID: "client-id",
  TEAMS_CLIENT_SECRET: "client-secret",
  TEAMS_BOT_TENANT: "botframework.com",
};
const CHAT = { serviceUrl: "https://smba.trafficmanager.net/emea/", conversationId: "a:1/b?c" };
const MESSAGE = { type: "message", text: "<p>Hi</p>", textFormat: "xml" } as const;

interface Call {
  method: string;
  url: string;
  body: string | null;
  auth: string | null;
}

/** A scripted Microsoft: each call answered by the first route whose URL prefix matches. */
function microsoft(routes: [string, () => Response][]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body === undefined ? null : String(init.body),
      auth: headers.Authorization ?? null,
    });
    const route = routes.find(([prefix]) => url.startsWith(prefix));
    return route ? route[1]() : new Response(`unexpected ${url}`, { status: 599 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const TOKEN = "https://login.microsoftonline.com/";
const SMBA = "https://smba.trafficmanager.net/";

describe("the serviceUrl allowlist", () => {
  it("admits the Teams hosts over https only", () => {
    for (const url of [
      "https://smba.trafficmanager.net/teams/",
      "https://smba.trafficmanager.net/emea/",
      "https://smba.trafficmanager.net/amer",
      "https://SMBA.trafficmanager.net/apac/",
    ]) {
      expect(allowedServiceUrl(url), url).toBe(true);
    }
    for (const url of [
      "http://smba.trafficmanager.net/teams/",
      "https://smba.trafficmanager.net:8443/teams/",
      "https://evil.example/teams/",
      "https://smba.trafficmanager.net.evil.example/",
      "https://user:pw@smba.trafficmanager.net/teams/",
      "https://smba.trafficmanager.net/teams/?x=1",
      "not a url",
    ]) {
      expect(allowedServiceUrl(url), url).toBe(false);
    }
  });
});

describe("sending", () => {
  it("takes a Bot Connector token from the bot's tenant, then posts the activity", async () => {
    const { fetchImpl, calls } = microsoft([
      [TOKEN, () => json({ access_token: "bot-token", expires_in: 3600 })],
      [SMBA, () => json({ id: "1" }, 201)],
    ]);
    const client = createTeamsClient({ ...config, TEAMS_BOT_TENANT: "tenant-home" }, fetchImpl);
    await client.send(CHAT, MESSAGE);
    await client.send(CHAT, MESSAGE);

    const token = calls[0]!;
    expect(token.url).toBe("https://login.microsoftonline.com/tenant-home/oauth2/v2.0/token");
    const form = new URLSearchParams(token.body!);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("https://api.botframework.com/.default");
    expect(form.get("client_id")).toBe("client-id");

    // The token is cached: two posts, one token.
    expect(calls.map((c) => c.url.startsWith(TOKEN))).toEqual([true, false, false]);
    const post = calls[1]!;
    expect(post.url).toBe("https://smba.trafficmanager.net/emea/v3/conversations/a%3A1%2Fb%3Fc/activities");
    expect(post.auth).toBe("Bearer bot-token");
    expect(JSON.parse(post.body!)).toEqual(MESSAGE);
  });

  it("never sends the token to a serviceUrl outside the allowlist", async () => {
    const { fetchImpl, calls } = microsoft([[TOKEN, () => json({ access_token: "bot-token" })]]);
    const client = createTeamsClient(config, fetchImpl);
    const err = await client
      .send({ serviceUrl: "https://evil.example/teams/", conversationId: "c" }, MESSAGE)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamsError);
    expect((err as TeamsError).permanent).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("marks 403 and 404 permanent, anything else retryable", async () => {
    for (const [status, permanent] of [
      [403, true],
      [404, true],
      [500, false],
      [429, false],
    ] as const) {
      const { fetchImpl } = microsoft([
        [TOKEN, () => json({ access_token: "bot-token" })],
        [SMBA, () => new Response("no", { status })],
      ]);
      const err = await createTeamsClient(config, fetchImpl)
        .send(CHAT, MESSAGE)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TeamsError);
      expect((err as TeamsError).status).toBe(status);
      expect((err as TeamsError).permanent).toBe(permanent);
    }
  });

  it("fails retryably when the bot cannot get a token (a lapsed secret)", async () => {
    const { fetchImpl } = microsoft([[TOKEN, () => json({ error: "invalid_client" }, 401)]]);
    const err = await createTeamsClient(config, fetchImpl)
      .send(CHAT, MESSAGE)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamsError);
    expect((err as TeamsError).permanent).toBe(false);
  });
});
