import { describe, expect, it } from "vitest";

import { createTeamsClient, TeamsError, type ActivityNotification } from "./teams.js";

const config = { TEAMS_CLIENT_ID: "client-id", TEAMS_CLIENT_SECRET: "client-secret" };
const HEIG = "a372f724-c0b2-4ea0-abfb-0eb8c6f84e40";
const OTHER = "96412a41-a2a2-422e-8438-f29c95c02686";
const LEA = { tenantId: HEIG, aadObjectId: "0f1e2d3c-0000-4000-8000-00000000a1d1" };
const ACTIVITY: ActivityNotification = {
  topic: "Test 0 — bases du C",
  webUrl: "https://teams.microsoft.com/l/entity/app/home?context=%7B%7D",
  activityType: "resultsReleased",
  previewText: "The results of “Test 0” are available.",
  templateParameters: { evaluationTitle: "Test 0 — bases du C" },
};

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
const LOGIN = "https://login.microsoftonline.com/";
const GRAPH = "https://graph.microsoft.com/";

describe("the Graph client", () => {
  it("takes an app token in the recipient's tenant, then sends the activity", async () => {
    const { fetchImpl, calls } = microsoft([
      [LOGIN, () => json({ access_token: "graph-token", expires_in: 3600 })],
      [GRAPH, () => new Response(null, { status: 204 })],
    ]);
    const client = createTeamsClient(config, fetchImpl);
    await client.notify(LEA, ACTIVITY);
    await client.notify(LEA, ACTIVITY);

    const token = calls[0]!;
    expect(token.url).toBe(`https://login.microsoftonline.com/${HEIG}/oauth2/v2.0/token`);
    const form = new URLSearchParams(token.body!);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(form.get("client_id")).toBe("client-id");
    expect(form.get("client_secret")).toBe("client-secret");

    // Cached for the tenant: two sends, one token.
    expect(calls.map((c) => c.url.startsWith(LOGIN))).toEqual([true, false, false]);
    const post = calls[1]!;
    expect(post.method).toBe("POST");
    expect(post.url).toBe(
      `https://graph.microsoft.com/v1.0/users/${LEA.aadObjectId}/teamwork/sendActivityNotification`,
    );
    expect(post.auth).toBe("Bearer graph-token");
    expect(JSON.parse(post.body!)).toEqual({
      topic: { source: "text", value: "Test 0 — bases du C", webUrl: ACTIVITY.webUrl },
      activityType: "resultsReleased",
      previewText: { content: "The results of “Test 0” are available." },
      templateParameters: [{ name: "evaluationTitle", value: "Test 0 — bases du C" }],
    });
  });

  it("keeps one token per tenant", async () => {
    let issued = 0;
    const { fetchImpl, calls } = microsoft([
      [LOGIN, () => json({ access_token: `token-${++issued}`, expires_in: 3600 })],
      [GRAPH, () => new Response(null, { status: 204 })],
    ]);
    const client = createTeamsClient(config, fetchImpl);
    await client.notify(LEA, ACTIVITY);
    await client.notify({ tenantId: OTHER, aadObjectId: "someone" }, ACTIVITY);
    await client.notify(LEA, ACTIVITY);
    const tokens = calls.filter((c) => c.url.startsWith(LOGIN)).map((c) => c.url);
    expect(tokens).toEqual([
      `https://login.microsoftonline.com/${HEIG}/oauth2/v2.0/token`,
      `https://login.microsoftonline.com/${OTHER}/oauth2/v2.0/token`,
    ]);
    expect(calls.filter((c) => c.url.startsWith(GRAPH)).map((c) => c.auth)).toEqual([
      "Bearer token-1",
      "Bearer token-2",
      "Bearer token-1",
    ]);
  });

  it("escapes the object id in the path", async () => {
    const { fetchImpl, calls } = microsoft([
      [LOGIN, () => json({ access_token: "t" })],
      [GRAPH, () => new Response(null, { status: 204 })],
    ]);
    await createTeamsClient(config, fetchImpl).notify({ tenantId: HEIG, aadObjectId: "../me?x" }, ACTIVITY);
    expect(calls[1]!.url).toBe(
      "https://graph.microsoft.com/v1.0/users/..%2Fme%3Fx/teamwork/sendActivityNotification",
    );
  });

  it("marks 403 and 404 permanent, with Graph's error code, anything else retryable", async () => {
    for (const [status, permanent] of [
      [403, true],
      [404, true],
      [400, false],
      [429, false],
      [500, false],
    ] as const) {
      const { fetchImpl } = microsoft([
        [LOGIN, () => json({ access_token: "t" })],
        [GRAPH, () => json({ error: { code: "Forbidden", message: "no" } }, status)],
      ]);
      const err = await createTeamsClient(config, fetchImpl)
        .notify(LEA, ACTIVITY)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TeamsError);
      expect((err as TeamsError).status).toBe(status);
      expect((err as TeamsError).code).toBe("Forbidden");
      expect((err as TeamsError).permanent).toBe(permanent);
      // Graph's code and the status, never Microsoft's prose.
      expect((err as TeamsError).message).toBe(`send the Teams activity: ${status} Forbidden`);
    }
  });

  it("fails retryably when no token can be had (a lapsed secret, the app unknown to the tenant)", async () => {
    for (const status of [400, 401, 403]) {
      const { fetchImpl, calls } = microsoft([
        [LOGIN, () => json({ error: "unauthorized_client", error_description: "AADSTS700016" }, status)],
      ]);
      const err = await createTeamsClient(config, fetchImpl)
        .notify(LEA, ACTIVITY)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TeamsError);
      expect((err as TeamsError).permanent).toBe(false);
      expect((err as TeamsError).code).toBe("unauthorized_client");
      expect((err as TeamsError).message).not.toContain("AADSTS");
      expect(calls.some((c) => c.url.startsWith(GRAPH))).toBe(false);
    }
  });
});
