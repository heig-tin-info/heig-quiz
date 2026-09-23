/**
 * `POST /app/api/mcp` — the MCP server (ADR-022, F-LLM-06): an LLM client
 * (Claude, ChatGPT, Codex, any MCP host) authors pools, questions,
 * evaluations and polls as the teacher whose personal API token it holds.
 *
 * Streamable HTTP transport, stateless: every POST carries one JSON-RPC
 * message (or a batch) and is answered in `application/json`. There is no
 * server-to-client stream, so `GET` is `405` as the specification allows.
 *
 * Authentication is a bearer token ONLY. A browser session is refused here:
 * nothing in a browser should be talking MCP, and a cookie is exactly the
 * credential a cross-site request carries without being asked to.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { OAUTH_SCOPE } from "@quiz/contracts";

import { MCP_PATH } from "../../auth/oauth/service.js";
import { INTERNAL_CALL_HEADER } from "../../auth/plugin.js";
import type { AppConfig } from "../../config.js";
import { handleMessage, RPC } from "./protocol.js";
import { ApiError, type Api } from "./tools.js";


export async function mcpPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;

  /** The in-process client of `/app/api`, acting with the caller's own token. */
  function apiFor(req: FastifyRequest): Api {
    const authorization = req.headers.authorization!;
    const call = async (
      method: "GET" | "POST" | "PUT" | "PATCH",
      path: string,
      body?: unknown,
      query?: Record<string, string | number | undefined>,
    ) => {
      const search = new URLSearchParams();
      for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) search.set(k, String(v));
      const qs = search.toString();
      const res = await app.inject({
        method,
        url: `/app/api${path}${qs ? `?${qs}` : ""}`,
        headers: {
          authorization,
          // An OAuth access token is bound to the MCP endpoint (RFC 8707);
          // this is what lets the SAME token through on the routes a tool
          // forwards to, and only from inside this process.
          [INTERNAL_CALL_HEADER]: app.internalCallSecret,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
      let parsed: unknown = null;
      if (res.body) {
        try {
          parsed = JSON.parse(res.body);
        } catch {
          parsed = res.body;
        }
      }
      if (res.statusCode >= 400) throw new ApiError(res.statusCode, parsed);
      return parsed as any;
    };
    return {
      get: (path, query) => call("GET", path, undefined, query),
      post: (path, body) => call("POST", path, body ?? {}),
      put: (path, body) => call("PUT", path, body),
      patch: (path, body) => call("PATCH", path, body),
      link: (path) => `${config.WEB_URL}${path}`,
    };
  }

  /**
   * RFC 9728 §5.1: the 401 names the protected resource metadata, which is
   * how claude.ai and ChatGPT find the OAuth server (ADR-023).
   * `error="invalid_token"` only when a token was actually presented.
   */
  function unauthenticated(req: FastifyRequest, reply: FastifyReply) {
    const metadata = `${config.PUBLIC_URL}/.well-known/oauth-protected-resource${MCP_PATH}`;
    const presented = /^Bearer\s/i.test(req.headers.authorization ?? "");
    return reply
      .code(401)
      .header(
        "www-authenticate",
        `Bearer resource_metadata="${metadata}", scope="${OAUTH_SCOPE}"${presented ? ', error="invalid_token"' : ""}`,
      )
      .send({ error: "unauthenticated", message: "Sign in with OAuth, or send a personal API token: Authorization: Bearer quiz_pat_…" });
  }

  app.post(MCP_PATH, { config: { readOnly: true } }, async (req, reply) => {
    if (!req.user || req.authVia !== "token") return unauthenticated(req, reply);
    if (req.user.role !== "teacher" && req.user.role !== "admin") {
      return reply.code(403).send({ error: "forbidden" });
    }
    const api = apiFor(req);
    const log = (err: unknown) => req.log.error({ err }, "mcp tool failed");
    const body = req.body;
    if (body === undefined || body === null || typeof body !== "object") {
      return reply.send({ jsonrpc: "2.0", id: null, error: { code: RPC.parseError, message: "Expected a JSON body" } });
    }
    if (Array.isArray(body)) {
      const out = [];
      for (const message of body) {
        const answer = await handleMessage(message, api, log);
        if (answer) out.push(answer);
      }
      return out.length === 0 ? reply.code(202).send() : reply.send(out);
    }
    const answer = await handleMessage(body, api, log);
    return answer ? reply.send(answer) : reply.code(202).send();
  });

  // No server-initiated stream, no session to terminate.
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header("allow", "POST").send({ error: "method_not_allowed" });
  app.get(MCP_PATH, notAllowed);
  app.delete(MCP_PATH, notAllowed);
}
