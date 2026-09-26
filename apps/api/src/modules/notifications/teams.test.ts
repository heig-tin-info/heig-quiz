import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createTeamsClient, jwtClaims, TeamsError } from "./teams.js";

const config = {
  TEAMS_CLIENT_ID: "client-id",
  TEAMS_CLIENT_SECRET: "client-secret",
  TEAMS_APP_ID: "teams-app",
  TEAMS_BOT_TENANT: "botframework.com",
  TEAMS_SERVICE_URL: "https://smba.test/teams",
};
const REDIRECT = "https://quiz.test/app/api/notifications/teams/callback";

interface Call {
  method: string;
  url: string;
  body: string | null;
  auth: string | null;
}

/**
 * A scripted Microsoft: each call is matched by method and URL prefix, in
 * order of declaration, and answered by the first route that matches.
 */
function microsoft(routes: [string, string | RegExp, () => Response][]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body === undefined ? null : String(init.body);
    calls.push({ method, url, body, auth: headers.Authorization ?? null });
    const route = routes.find(
      ([m, match]) => m === method && (typeof match === "string" ? url.startsWith(match) : match.test(url)),
    );
    if (!route) return new Response(`unexpected ${method} ${url}`, { status: 599 });
    return route[2]();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** An unsigned JWT: the client reads its claims, it does not verify them. */
function idToken(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.`;
}

const TOKEN = "https://login.microsoftonline.com/";

describe("linking", () => {
  it("starts an authorization-code flow with PKCE S256, state and nonce", () => {
    const client = createTeamsClient(config, microsoft([]).fetchImpl);
    const start = client.beginLink(REDIRECT);
    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    );
    const q = url.searchParams;
    expect(q.get("client_id")).toBe("client-id");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("redirect_uri")).toBe(REDIRECT);
    expect(q.get("scope")).toBe("openid profile");
    expect(q.get("state")).toBe(start.state);
    expect(q.get("nonce")).toBe(start.nonce);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBe(
      createHash("sha256").update(start.codeVerifier).digest("base64url"),
    );
    // Two attempts share nothing.
    expect(client.beginLink(REDIRECT).state).not.toBe(start.state);
  });

  it("redeems the code and keeps only the tenant and the object id", async () => {
    const claims = {
      aud: "client-id",
      nonce: "n-1",
      tid: "tenant-1",
      oid: "object-1",
      iss: "https://login.microsoftonline.com/tenant-1/v2.0",
    };
    const ms = microsoft([
      [
        "POST",
        `${TOKEN}organizations/oauth2/v2.0/token`,
        () => json({ id_token: idToken(claims), access_token: "never-kept", refresh_token: "never-kept" }),
      ],
    ]);
    const client = createTeamsClient(config, ms.fetchImpl);
    const identity = await client.completeLink({
      code: "the-code",
      redirectUri: REDIRECT,
      codeVerifier: "verifier",
      nonce: "n-1",
    });
    expect(identity).toEqual({ tenantId: "tenant-1", objectId: "object-1" });
    const form = new URLSearchParams(ms.calls[0]!.body!);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("code_verifier")).toBe("verifier");
    expect(form.get("redirect_uri")).toBe(REDIRECT);
    expect(form.get("client_secret")).toBe("client-secret");
  });

  it("refuses an ID token for another client, another attempt or a forged tenant", async () => {
    const good = {
      aud: "client-id",
      nonce: "n-1",
      tid: "tenant-1",
      oid: "object-1",
      iss: "https://login.microsoftonline.com/tenant-1/v2.0",
    };
    const cases: Record<string, unknown>[] = [
      { ...good, aud: "someone-else" },
      { ...good, nonce: "n-2" },
      { ...good, iss: "https://login.microsoftonline.com/tenant-2/v2.0" },
      { ...good, oid: undefined },
    ];
    for (const claims of cases) {
      const ms = microsoft([["POST", TOKEN, () => json({ id_token: idToken(claims) })]]);
      const client = createTeamsClient(config, ms.fetchImpl);
      await expect(
        client.completeLink({ code: "c", redirectUri: REDIRECT, codeVerifier: "v", nonce: "n-1" }),
      ).rejects.toBeInstanceOf(TeamsError);
    }
    const refused = microsoft([["POST", TOKEN, () => json({ error: "invalid_grant" }, 400)]]);
    await expect(
      createTeamsClient(config, refused.fetchImpl).completeLink({
        code: "c",
        redirectUri: REDIRECT,
        codeVerifier: "v",
        nonce: "n-1",
      }),
    ).rejects.toThrow(/400/);
  });

  it("reads the claims of a token and refuses garbage", () => {
    expect(jwtClaims(idToken({ a: 1 }))).toEqual({ a: 1 });
    expect(() => jwtClaims("not-a-jwt")).toThrow(TeamsError);
  });
});

describe("sending", () => {
  const target = { tenantId: "tenant-1", objectId: "object-1", chatId: null };
  const INSTALLED = "https://graph.microsoft.com/v1.0/users/object-1/teamwork/installedApps";

  function happyMicrosoft(install: number) {
    return microsoft([
      ["POST", `${TOKEN}tenant-1/oauth2/v2.0/token`, () => json({ access_token: "graph", expires_in: 3600 })],
      ["POST", `${TOKEN}botframework.com/oauth2/v2.0/token`, () => json({ access_token: "bot", expires_in: 3600 })],
      ["POST", INSTALLED, () => new Response(null, { status: install })],
      ["GET", /installedApps\/inst-1\/chat$/, () => json({ id: "19:chat@unq.gbl.spaces" })],
      ["GET", `${INSTALLED}?`, () => json({ value: [{ id: "inst-1" }] })],
      ["POST", "https://smba.test/teams/v3/conversations/", () => json({ id: "activity" }, 201)],
    ]);
  }

  for (const install of [201, 409]) {
    it(`installs the app (${install}), finds the chat and posts the message`, async () => {
      const ms = happyMicrosoft(install);
      const client = createTeamsClient(config, ms.fetchImpl);
      const sent = await client.send(target, "<p>Hello</p>");
      expect(sent).toEqual({ chatId: "19:chat@unq.gbl.spaces" });

      const graphToken = new URLSearchParams(ms.calls[0]!.body!);
      expect(graphToken.get("grant_type")).toBe("client_credentials");
      expect(graphToken.get("scope")).toBe("https://graph.microsoft.com/.default");

      const installCall = ms.calls.find((c) => c.method === "POST" && c.url === INSTALLED)!;
      expect(installCall.auth).toBe("Bearer graph");
      expect(JSON.parse(installCall.body!)).toEqual({
        "teamsApp@odata.bind": "https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/teams-app",
      });

      const botToken = ms.calls.find((c) => c.url.includes("botframework.com"))!;
      expect(new URLSearchParams(botToken.body!).get("scope")).toBe(
        "https://api.botframework.com/.default",
      );
      const post = ms.calls.at(-1)!;
      expect(post.url).toBe(
        "https://smba.test/teams/v3/conversations/19%3Achat%40unq.gbl.spaces/activities",
      );
      expect(post.auth).toBe("Bearer bot");
      expect(JSON.parse(post.body!)).toEqual({
        type: "message",
        textFormat: "xml",
        text: "<p>Hello</p>",
      });
    });
  }

  it("skips Graph when the chat is cached, and reuses its tokens", async () => {
    const ms = happyMicrosoft(201);
    const client = createTeamsClient(config, ms.fetchImpl);
    await client.send({ ...target, chatId: "19:cached" }, "<p>1</p>");
    await client.send({ ...target, chatId: "19:cached" }, "<p>2</p>");
    expect(ms.calls.some((c) => c.url.startsWith("https://graph.microsoft.com"))).toBe(false);
    // One bot token for both messages.
    expect(ms.calls.filter((c) => c.url.includes("botframework.com"))).toHaveLength(1);
  });

  it("finds the chat again when the cached one is gone", async () => {
    let first = true;
    const ms = microsoft([
      ["POST", `${TOKEN}tenant-1/`, () => json({ access_token: "graph", expires_in: 3600 })],
      ["POST", `${TOKEN}botframework.com/`, () => json({ access_token: "bot", expires_in: 3600 })],
      ["POST", INSTALLED, () => new Response(null, { status: 409 })],
      ["GET", /\/chat$/, () => json({ id: "19:new" })],
      ["GET", `${INSTALLED}?`, () => json({ value: [{ id: "inst-1" }] })],
      [
        "POST",
        "https://smba.test/",
        () => {
          const gone = first;
          first = false;
          return gone ? new Response("", { status: 404 }) : json({ id: "a" }, 201);
        },
      ],
    ]);
    const sent = await createTeamsClient(config, ms.fetchImpl).send(
      { ...target, chatId: "19:old" },
      "<p>x</p>",
    );
    expect(sent.chatId).toBe("19:new");
  });

  it("throws when Microsoft refuses, so the job is retried", async () => {
    const ms = microsoft([
      ["POST", `${TOKEN}tenant-1/`, () => json({ error: "unauthorized_client" }, 401)],
    ]);
    await expect(createTeamsClient(config, ms.fetchImpl).send(target, "x")).rejects.toThrow(/401/);

    const noConsent = microsoft([
      ["POST", `${TOKEN}tenant-1/`, () => json({ access_token: "graph", expires_in: 3600 })],
      ["POST", INSTALLED, () => json({ error: { code: "Forbidden" } }, 403)],
    ]);
    await expect(createTeamsClient(config, noConsent.fetchImpl).send(target, "x")).rejects.toThrow(
      /install the Teams app: 403/,
    );
  });
});
