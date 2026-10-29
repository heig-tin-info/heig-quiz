/**
 * What the `mcp` module offers the others: its tool catalogue and the
 * in-process client of `/app/api` its tools call through. The help
 * assistant (ADR-080 §8) reads with the same tools, through the same chain,
 * so the access loaders, the contracts and the audit are the routes' own.
 */
import type { FastifyInstance } from "fastify";

import { INTERNAL_CALL_HEADER } from "../../auth/plugin.js";
import { ApiError, ToolRefusal, type Api } from "./tools.js";
export { checkConfig } from "./questionTypes.js";

export {
  ApiError,
  inputJsonSchema,
  runTool,
  ToolRefusal,
  toolByName,
  type Api,
  type Tool,
  type ToolFailure,
} from "./tools.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * The DELETE routes a tool may reach, a CLOSED list (ADR-022, amendment of
 * 2026-10-29): an item of an evaluation's or a template's list. Removing an
 * item is an edit of that list, not a deletion; any other DELETE path is
 * refused before a request is made.
 */
export const DELETABLE_PATHS: readonly RegExp[] = [
  new RegExp(`^/evaluations/${UUID}/items/${UUID}$`, "i"),
  new RegExp(`^/templates/${UUID}/items/${UUID}$`, "i"),
];

/**
 * The in-process client of `/app/api`, acting with a bearer token
 * (`authorization` is the whole header): every call is an `app.inject`, so a
 * tool reaches exactly what the token's owner reaches, and a refusal is an
 * `ApiError` with the route's own status and body. `webUrl` makes the web
 * app's links a tool hands back. `extra` adds headers to every call (the
 * assistant's tool name, `ASSIST_TOOL_HEADER`, ADR-080 P3). `github` says
 * whether the project routes exist: they are registered only with Quiz's
 * App configured (`app.ts`).
 */
export function injectedApi(
  app: FastifyInstance,
  authorization: string,
  webUrl: string,
  extra: Readonly<Record<string, string>> = {},
): Api {
  const github = app.hasRoute({ method: "GET", url: "/app/api/classrooms/:id/projects" });
  const call = async (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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
        ...extra,
        authorization,
        // An OAuth access token is bound to the MCP endpoint (RFC 8707), the
        // help assistant's to these calls (ADR-080 §8); this is what lets the
        // SAME token through on the routes a tool forwards to, and only from
        // inside this process.
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
    delete: (path) =>
      DELETABLE_PATHS.some((allowed) => allowed.test(path))
        ? call("DELETE", path)
        : Promise.reject(new ToolRefusal("No tool deletes this; nothing was sent.")),
    link: (path) => `${webUrl}${path}`,
    github,
  };
}
