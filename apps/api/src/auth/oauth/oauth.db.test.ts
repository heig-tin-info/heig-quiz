/**
 * The OAuth 2.1 server over the REAL application (ADR-023), walked the way
 * claude.ai and ChatGPT walk it: discovery from the 401, registration (DCR)
 * or a metadata document (CIMD), authorize, the teacher's consent, the code
 * exchange with PKCE, the MCP call, the refresh with rotation, revocation.
 */
import { createHash, randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { testServer, type TestServer } from "../../test/http.js";

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };

const ISSUER = "http://localhost:3000";
const RESOURCE = `${ISSUER}/app/api/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
});
afterAll(() => server.close());
afterEach(() => vi.restoreAllMocks());

const inject = (opts: Parameters<TestServer["app"]["inject"]>[0]) => server.app.inject(opts);

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(redirectUris: string[] = [REDIRECT]) {
  const res = await inject({
    method: "POST",
    url: "/app/oauth/register",
    payload: { redirect_uris: redirectUris, client_name: "Claude", token_endpoint_auth_method: "none" },
  });
  return { status: res.statusCode, body: res.json() as { client_id: string; token_endpoint_auth_method: string } };
}

function authorizeUrl(params: Record<string, string>) {
  return `/app/oauth/authorize?${new URLSearchParams(params).toString()}`;
}

/** Authorize → consent (approved by `headers`) → the redirect back, parsed. */
async function consent(clientId: string, challenge: string, opts: { redirect?: string; approve?: boolean; headers?: Record<string, string> } = {}) {
  const start = await inject({
    method: "GET",
    url: authorizeUrl({
      response_type: "code",
      client_id: clientId,
      redirect_uri: opts.redirect ?? REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      scope: "quiz",
      resource: RESOURCE,
    }),
  });
  expect(start.statusCode).toBe(303);
  const location = start.headers.location as string;
  expect(location).toMatch(/^\/oauth\/authorize\/[0-9a-f-]{36}$/);
  const id = location.split("/").pop()!;
  const decision = await inject({
    method: "POST",
    url: `/app/api/oauth/requests/${id}/decision`,
    headers: opts.headers ?? teacher.headers,
    payload: { approve: opts.approve ?? true },
  });
  return { id, decision, back: decision.statusCode === 200 ? new URL(decision.json().redirectTo) : null };
}

async function token(form: Record<string, string>) {
  const res = await inject({
    method: "POST",
    url: "/app/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(form).toString(),
  });
  return { status: res.statusCode, body: res.json() as Record<string, string>, headers: res.headers };
}

async function mcp(accessToken: string, method: string, params?: unknown) {
  return inject({
    method: "POST",
    url: "/app/api/mcp",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) },
  });
}

describe("discovery", () => {
  it("points the 401 of the MCP endpoint at the protected resource metadata", async () => {
    const res = await inject({ method: "POST", url: "/app/api/mcp", payload: { jsonrpc: "2.0", id: 1, method: "ping" } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/app/api/mcp", scope="quiz"`,
    );
  });

  it("serves the resource and server metadata the clients require", async () => {
    for (const url of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/app/api/mcp"]) {
      const prm = (await inject({ method: "GET", url })).json();
      expect(prm).toMatchObject({ resource: RESOURCE, authorization_servers: [ISSUER] });
    }
    const as = (await inject({ method: "GET", url: "/.well-known/oauth-authorization-server" })).json();
    expect(as).toMatchObject({
      issuer: ISSUER,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      registration_endpoint: `${ISSUER}/app/oauth/register`,
    });
  });
});

describe("the whole flow, with a registered client", () => {
  it("issues a token bound to the MCP endpoint, refreshes it, and revokes it", async () => {
    const { status, body: client } = await register();
    expect(status).toBe(201);
    expect(client.token_endpoint_auth_method).toBe("none");

    const { verifier, challenge } = pkce();
    const { back } = await consent(client.client_id, challenge);
    expect(back!.origin + back!.pathname).toBe(REDIRECT);
    expect(back!.searchParams.get("state")).toBe("xyz");
    expect(back!.searchParams.get("iss")).toBe(ISSUER);
    const code = back!.searchParams.get("code")!;

    const exchanged = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: client.client_id,
      resource: RESOURCE,
    });
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers["cache-control"]).toBe("no-store");
    expect(exchanged.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "quiz" });
    const access = exchanged.body.access_token!;

    // The MCP endpoint takes it, and so do the routes a tool forwards to…
    expect((await mcp(access, "ping")).statusCode).toBe(200);
    const created = await mcp(access, "tools/call", { name: "create_pool", arguments: { name: "Via OAuth" } });
    expect(JSON.parse(created.json().result.content[0].text)).toMatchObject({ name: "Via OAuth" });
    // …but the rest of the API refuses it: its audience is the MCP endpoint.
    const direct = await inject({ method: "GET", url: "/app/api/courses", headers: { authorization: `Bearer ${access}` } });
    expect(direct.statusCode).toBe(401);

    // A code is worth one exchange.
    const again = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: client.client_id });
    expect(again.body.error).toBe("invalid_grant");

    // Refresh rotates: the new one works, the old one is dead.
    const refreshed = await token({ grant_type: "refresh_token", refresh_token: exchanged.body.refresh_token!, client_id: client.client_id });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(exchanged.body.refresh_token);
    const replay = await token({ grant_type: "refresh_token", refresh_token: exchanged.body.refresh_token!, client_id: client.client_id });
    expect(replay.body.error).toBe("invalid_grant");

    // The teacher sees the assistant, and revoking it kills its tokens.
    const connections = await inject({ method: "GET", url: "/app/api/me/connections", headers: teacher.headers });
    const mine = (connections.json() as { id: string; clientName: string }[]).find((c) => c.clientName === "Claude")!;
    expect(mine).toBeDefined();
    const revoked = await inject({ method: "DELETE", url: `/app/api/me/connections/${mine.id}`, headers: teacher.headers });
    expect(revoked.statusCode).toBe(204);
    expect((await mcp(refreshed.body.access_token!, "ping")).statusCode).toBe(401);
    const afterRevoke = await token({ grant_type: "refresh_token", refresh_token: refreshed.body.refresh_token!, client_id: client.client_id });
    expect(afterRevoke.body.error).toBe("invalid_grant");
  });

  it("refuses a wrong PKCE verifier", async () => {
    const { body: client } = await register();
    const { challenge } = pkce();
    const { back } = await consent(client.client_id, challenge);
    const res = await token({
      grant_type: "authorization_code",
      code: back!.searchParams.get("code")!,
      redirect_uri: REDIRECT,
      code_verifier: pkce().verifier,
      client_id: client.client_id,
    });
    expect(res.body.error).toBe("invalid_grant");
  });

  it("refuses a code after its minute", async () => {
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const { back } = await consent(client.client_id, challenge);
    server.clock.advance(61_000);
    const res = await token({
      grant_type: "authorization_code",
      code: back!.searchParams.get("code")!,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: client.client_id,
    });
    expect(res.body.error).toBe("invalid_grant");
  });

  it("sends a denial back as access_denied", async () => {
    const { body: client } = await register();
    const { back } = await consent(client.client_id, pkce().challenge, { approve: false });
    expect(back!.searchParams.get("error")).toBe("access_denied");
    expect(back!.searchParams.get("code")).toBeNull();
  });
});

describe("refusals", () => {
  it("never redirects to an address the client did not register", async () => {
    const { body: client } = await register();
    const res = await inject({
      method: "GET",
      url: authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "https://evil.example/callback",
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
      }),
    });
    expect(res.headers.location).toBe("/oauth/authorize/invalid?reason=invalid_redirect_uri");
  });

  it("sends a request without PKCE back to the client with an error", async () => {
    const { body: client } = await register();
    const res = await inject({
      method: "GET",
      url: authorizeUrl({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, state: "s" }),
    });
    const back = new URL(res.headers.location as string);
    expect(back.searchParams.get("error")).toBe("invalid_request");
    expect(back.searchParams.get("state")).toBe("s");
  });

  it("refuses to register a plain-http redirect off this machine", async () => {
    const { status } = await register(["http://evil.example/callback"]);
    expect(status).toBe(400);
  });

  it("keeps a student off the consent page", async () => {
    const { body: client } = await register();
    const student = await server.signIn("student");
    const { decision } = await consent(client.client_id, pkce().challenge, { headers: student.headers });
    expect(decision.statusCode).toBe(403);
  });

  it("lets no token approve a request: consent takes a browser session", async () => {
    const minted = await inject({ method: "POST", url: "/app/api/me/tokens", headers: teacher.headers, payload: { name: "t" } });
    const { body: client } = await register();
    const { decision } = await consent(client.client_id, pkce().challenge, {
      headers: { authorization: `Bearer ${minted.json().token}` },
    });
    expect(decision.statusCode).toBe(403);
  });
});

describe("a client identified by its metadata document (CIMD)", () => {
  const CLIENT_ID = "https://claude.ai/oauth/claude-code-client-metadata";

  it("fetches the document from an allowed host, and matches a loopback redirect on any port", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ client_id: CLIENT_ID, client_name: "Claude Code", redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const { verifier, challenge } = pkce();
    const redirect = "http://localhost:39152/callback";
    const { back } = await consent(CLIENT_ID, challenge, { redirect });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(back!.origin).toBe("http://localhost:39152");
    const res = await token({
      grant_type: "authorization_code",
      code: back!.searchParams.get("code")!,
      redirect_uri: redirect,
      code_verifier: verifier,
      client_id: CLIENT_ID,
    });
    expect(res.status).toBe(200);
  });

  it("never fetches a document from a host off the list", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await inject({
      method: "GET",
      url: authorizeUrl({
        response_type: "code",
        client_id: "https://evil.example/client.json",
        redirect_uri: "https://evil.example/cb",
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
      }),
    });
    expect(res.headers.location).toBe("/oauth/authorize/invalid?reason=invalid_client");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
