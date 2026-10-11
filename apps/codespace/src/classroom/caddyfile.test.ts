/**
 * The front door of the service API (#744, audit L25): `deploy/Caddyfile`
 * answers 403 on `/api/*` to every address but Quiz's application VM.
 *
 * Caddy is not in CI, so this holds the template to what it must match:
 *
 *  - its path patterns, applied to the real portal's route table (a portal
 *    built as `server.ts` builds it), cover exactly the two service routes,
 *    and each of them is guarded by the service token — never `/launch`, the
 *    proxy or a page, which students reach from anywhere;
 *  - its address list is the application VM's, as
 *    `docs/development/deployment.md` §1 records it (A and AAAA).
 *
 * The matcher's syntax itself is checked by `caddy validate` at every deploy
 * (`deploy/lib.sh`, `cs_install_instance`).
 */
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../auth/config.js";
import { openDb, type DbHandle } from "../db/client.js";
import type { Engine } from "../engine/index.js";
import { buildPortal, type Portal } from "../server.js";

const CADDYFILE = readFileSync(new URL("../../deploy/Caddyfile", import.meta.url), "utf8");
const DEPLOYMENT = readFileSync(
  new URL("../../../../docs/development/deployment.md", import.meta.url),
  "utf8",
);

/** The service routes of `routes.ts`, which only Quiz's API calls. */
const SERVICE_ROUTES = [
  "GET /api/assignments/:assignmentId/sessions",
  "HEAD /api/assignments/:assignmentId/sessions",
  "PUT /api/assignments/:assignmentId",
];

/** The `@service_elsewhere` named matcher's block: its `path` patterns and its excluded addresses. */
function serviceMatcher(): { paths: string[]; allowed: string[] } {
  const block = /@service_elsewhere \{\n([\s\S]*?)\n\t\}/.exec(CADDYFILE)?.[1] ?? "";
  const words = (directive: RegExp): string[] =>
    (directive.exec(block)?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
  return { paths: words(/^\t\tpath (.+)$/m), allowed: words(/^\t\tnot remote_ip (.+)$/m) };
}

/**
 * Caddy's `path` matcher for the shapes this file uses: an exact path or a
 * trailing `*` (a prefix), case-insensitive. Anything else fails loudly, so
 * a new shape in the Caddyfile extends this function first.
 */
function caddyPathMatches(pattern: string, path: string): boolean {
  const p = pattern.toLowerCase();
  const actual = path.toLowerCase();
  if (!p.includes("*")) return actual === p;
  if (p.indexOf("*") === p.length - 1) return actual.startsWith(p.slice(0, -1));
  throw new Error(`pattern shape not modelled here: ${pattern}`);
}

/**
 * Every route of a built portal, `METHOD /path`, from Fastify's
 * `printRoutes` tree: one node per line, four columns per level, a node's
 * path is its ancestors' segments joined.
 */
function routeTable(portal: Portal): string[] {
  const stack: string[] = [];
  const routes: string[] = [];
  for (const line of portal.app.printRoutes({ commonPrefix: false }).split("\n")) {
    const node = /^(.*?)[├└]── (\S+)(?: \(([^)]+)\))?$/.exec(line);
    if (!node) continue;
    const depth = [...(node[1] ?? "")].length / 4;
    stack.length = depth;
    stack.push(node[2] ?? "");
    for (const method of (node[3] ?? "").split(", ").filter(Boolean)) {
      routes.push(`${method} ${stack.join("")}`);
    }
  }
  return routes;
}

/** A concrete URL for a route template: every parameter and wildcard filled. */
const concrete = (path: string): string => path.replace(/:[^/]+/g, "x").replace(/\*/g, "x");

const SECRET = "test-launch-secret-0123456789012345";
let handle: DbHandle | null = null;
let portal: Portal | null = null;

afterEach(async () => {
  await portal?.close();
  handle?.close();
  portal = null;
  handle = null;
});

describe("the Caddy allow-list of the service API", () => {
  it("matches the service routes of the real portal, and nothing a student reaches", async () => {
    handle = openDb(":memory:");
    portal = await buildPortal({
      config: loadConfig({ LOG_LEVEL: "fatal", SEB_VERIFIER: "simulated", CODESPACE_LAUNCH_SECRET: SECRET }),
      dbHandle: handle,
      engine: {} as Engine,
      withGitServer: false,
      withTimers: false,
    });
    await portal.app.ready();

    const { paths } = serviceMatcher();
    expect(paths).not.toEqual([]);
    const table = routeTable(portal);
    // The parser read the table: the public routes are there too.
    expect(table).toEqual(expect.arrayContaining(["GET /launch", "GET /s/:sid/*", "GET /healthz", "GET /"]));

    const restricted = table.filter((route) => {
      const path = concrete(route.split(" ")[1] ?? "");
      return paths.some((pattern) => caddyPathMatches(pattern, path));
    });
    expect(restricted.sort()).toEqual(SERVICE_ROUTES);

    // Each restricted route is a service route: without a token, the
    // service token's 401.
    for (const route of restricted.filter((r) => !r.startsWith("HEAD "))) {
      const [method, path] = route.split(" ") as ["GET" | "PUT", string];
      const reply = await portal.app.inject({ method, url: concrete(path), ...(method === "PUT" ? { payload: {} } : {}) });
      expect(reply.statusCode, route).toBe(401);
    }
  });

  it("answers the application VM's addresses only, as deployment.md records them", () => {
    const { allowed } = serviceMatcher();
    const dns = /A\s+`(\d+\.\d+\.\d+\.\d+)`, AAAA `([0-9a-f:]+)`/.exec(DEPLOYMENT);
    expect(dns, "deployment.md §1 lists the application VM's A and AAAA").not.toBeNull();
    expect(allowed).toEqual([dns?.[1], dns?.[2]]);
    expect(CADDYFILE).toMatch(/^\trespond @service_elsewhere 403$/m);
  });
});
