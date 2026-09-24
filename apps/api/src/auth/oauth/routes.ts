/**
 * The OAuth 2.1 authorization server in front of the MCP endpoint (ADR-023),
 * the one claude.ai and ChatGPT sign in through.
 *
 *   GET  /.well-known/oauth-protected-resource[/app/api/mcp]   RFC 9728
 *   GET  /.well-known/oauth-authorization-server               RFC 8414
 *   POST /app/oauth/register                                   RFC 7591
 *   GET  /app/oauth/authorize          → the SPA's consent page /oauth/authorize/:id
 *   POST /app/oauth/token              authorization_code (PKCE S256) | refresh_token
 *
 * and, for the SPA (a teacher in a browser, never a token):
 *
 *   GET  /app/api/oauth/requests/:id            what the consent page shows
 *   POST /app/api/oauth/requests/:id/decision   allow or deny
 *   GET  /app/api/me/connections                the assistants let in
 *   DELETE /app/api/me/connections/:id          revoke one
 *
 * The issuer is `PUBLIC_URL`. edu-ID is not involved beyond being how the
 * teacher signs in to the portal before the consent page: the tokens are ours.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  AuthorizeQuery,
  ClientRegistration,
  IdParam,
  OAUTH_SCOPE,
  OAUTH_SCOPES_SUPPORTED,
  OAuthDecision,
  TokenRequest,
  type OAuthDecisionResult,
} from "@quiz/contracts";

import { audit } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { invalid, notFound } from "../../modules/http.js";
import { sessionTeacherGuard } from "../tokenRoutes.js";
import { ClientRefused, redirectMatches, registerClient, resolveClient } from "./clients.js";
import {
  MCP_PATH,
  OAuthError,
  createRequest,
  decide,
  exchangeCode,
  grantedScope,
  listConnections,
  mcpResource,
  refresh,
  requestView,
  revokeConnection,
  sameResource,
} from "./service.js";

/** Self-registrations per address and hour: DCR is open to anyone, so it is metered. */
const REGISTRATIONS_PER_HOUR = 30;

export async function oauthRoutes(app: FastifyInstance, config: AppConfig) {
  const issuer = config.PUBLIC_URL;
  const resource = mcpResource(issuer);
  const allowedHosts = config.OAUTH_CIMD_HOSTS.split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
  const sessionTeacher = sessionTeacherGuard(app);

  // --- Discovery -----------------------------------------------------------

  const protectedResource = {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "HEIG-VD Quiz",
  };
  app.get("/.well-known/oauth-protected-resource", async () => protectedResource);
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, async () => protectedResource);

  app.get("/.well-known/oauth-authorization-server", async () => ({
    issuer,
    authorization_endpoint: `${issuer}/app/oauth/authorize`,
    token_endpoint: `${issuer}/app/oauth/token`,
    registration_endpoint: `${issuer}/app/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }));

  // --- Registration (RFC 7591) ----------------------------------------------

  const registrations = new Map<string, { count: number; since: number }>();
  app.post("/app/oauth/register", async (req, reply) => {
    const now = app.clock.now().getTime();
    const seen = registrations.get(req.ip);
    const window = seen && now - seen.since < 3_600_000 ? seen : { count: 0, since: now };
    if (window.count >= REGISTRATIONS_PER_HOUR) {
      return reply.code(429).send({ error: "slow_down", error_description: "Too many registrations" });
    }
    registrations.set(req.ip, { count: window.count + 1, since: window.since });

    const body = ClientRegistration.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_client_metadata", error_description: body.error.message });
    }
    try {
      const client = await registerClient(app.db, body.data, app.clock.now());
      return reply.code(201).header("cache-control", "no-store").send({
        client_id: client.id,
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: OAUTH_SCOPE,
      });
    } catch (error) {
      if (error instanceof ClientRefused) {
        return reply.code(400).send({ error: error.reason, error_description: "Redirect URIs must be https, or http on localhost" });
      }
      throw error;
    }
  });

  // --- Authorization --------------------------------------------------------

  /** A refusal that cannot be trusted to a redirect URI: the SPA says it. */
  const refuse = (reply: FastifyReply, reason: string) =>
    reply.redirect(`/oauth/authorize/invalid?reason=${encodeURIComponent(reason)}`, 303);

  app.get("/app/oauth/authorize", async (req, reply) => {
    const now = app.clock.now();
    const query = AuthorizeQuery.safeParse(req.query ?? {});
    if (!query.success) return refuse(reply, "invalid_request");
    const q = query.data;

    let client;
    try {
      client = await resolveClient(app.db, q.client_id, { allowedHosts, now });
    } catch (error) {
      if (error instanceof ClientRefused) return refuse(reply, error.reason);
      throw error;
    }
    if (!redirectMatches(client.redirectUris, q.redirect_uri)) return refuse(reply, "invalid_redirect_uri");

    // From here the client and its redirect are trusted: errors go back to it.
    const back = (error: string, description: string) => {
      const url = new URL(q.redirect_uri);
      url.searchParams.set("error", error);
      url.searchParams.set("error_description", description);
      if (q.state !== undefined) url.searchParams.set("state", q.state);
      url.searchParams.set("iss", issuer);
      return reply.redirect(url.href, 303);
    };
    if (q.response_type !== "code") return back("unsupported_response_type", "Only the code flow is supported");
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      return back("invalid_request", "PKCE with S256 is required");
    }
    if (q.resource !== undefined && !sameResource(q.resource, resource)) {
      return back("invalid_target", `This server only issues tokens for ${resource}`);
    }
    const id = await createRequest(app.db, {
      client,
      redirectUri: q.redirect_uri,
      codeChallenge: q.code_challenge,
      scope: grantedScope(q.scope),
      resource,
      state: q.state ?? null,
      now,
    });
    return reply.redirect(`/oauth/authorize/${id}`, 303);
  });

  // --- Token ----------------------------------------------------------------

  /** A public client may still send its id as the user of a Basic header. */
  function basicClientId(req: FastifyRequest): string | undefined {
    const m = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? "");
    if (!m) return undefined;
    const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
    const user = decoded.split(":")[0];
    return user ? decodeURIComponent(user) : undefined;
  }

  app.post("/app/oauth/token", async (req, reply) => {
    reply.header("cache-control", "no-store").header("pragma", "no-cache");
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const body = TokenRequest.safeParse(raw);
    if (!body.success) {
      const unsupported = typeof raw.grant_type === "string" && !["authorization_code", "refresh_token"].includes(raw.grant_type);
      return reply.code(400).send({
        error: unsupported ? "unsupported_grant_type" : "invalid_request",
        error_description: unsupported ? "Unsupported grant_type" : "Malformed token request",
      });
    }
    const now = app.clock.now();
    const clientId = body.data.client_id ?? basicClientId(req);
    try {
      const tokens =
        body.data.grant_type === "authorization_code"
          ? await exchangeCode(app.db, {
              code: body.data.code,
              redirectUri: body.data.redirect_uri,
              verifier: body.data.code_verifier,
              clientId,
              resource: body.data.resource,
              now,
            })
          : await refresh(app.db, {
              refreshToken: body.data.refresh_token,
              clientId,
              resource: body.data.resource,
              now,
            });
      return tokens;
    } catch (error) {
      if (error instanceof OAuthError) {
        return reply.code(400).send({ error: error.error, error_description: error.description });
      }
      throw error;
    }
  });

  // --- The consent page (SPA) -------------------------------------------------

  app.get("/app/api/oauth/requests/:id", { preHandler: sessionTeacher }, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const view = await requestView(app.db, params.data.id, app.clock.now());
    return view ?? notFound(reply);
  });

  app.post("/app/api/oauth/requests/:id/decision", { preHandler: sessionTeacher }, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const body = OAuthDecision.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    const answer = await decide(app.db, {
      id: params.data.id,
      userId: req.user!.id,
      approve: body.data.approve,
      issuer,
      now: app.clock.now(),
    });
    if (!answer) return notFound(reply);
    if (body.data.approve) {
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "oauth.grant",
        subjectType: "oauth_client",
        subjectId: answer.clientId,
      });
    }
    const result: OAuthDecisionResult = { redirectTo: answer.redirectTo };
    return result;
  });

  // --- Connected assistants ---------------------------------------------------

  app.get("/app/api/me/connections", { preHandler: sessionTeacher }, async (req) =>
    listConnections(app.db, req.user!.id, app.clock.now()),
  );

  app.delete("/app/api/me/connections/:id", { preHandler: sessionTeacher }, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const grant = await revokeConnection(app.db, req.user!.id, params.data.id, app.clock.now());
    if (!grant) return notFound(reply);
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "oauth.revoke",
      subjectType: "oauth_grant",
      subjectId: grant.id,
      payload: { clientId: grant.clientId },
    });
    return reply.code(204).send();
  });
}
