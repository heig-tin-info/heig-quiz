import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { HealthResponse } from "@quiz/contracts";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { CSP, TEAMS_TAB_CSP } from "./csp.js";

// M1 foundation: the server must start and respond even without a reachable
// database (healthz "degraded", never a crash), a precondition for the 11 pm
// diagnosis.
describe("app (without a database)", () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://nobody:nope@127.0.0.1:59999/absent",
    // The database is deliberately absent; pg-boss would answer that by
    // retrying and printing an ECONNREFUSED stack trace per attempt, which
    // says nothing and drowns the output of every other test file.
    JOBS_DISABLED: "1",
    // No background worker either: the ticker would re-read the absent
    // database every second and log one failure per task per tick. What this
    // file is about is the REQUEST path surviving a dead database.
    WORKER_MODE: "web",
    // The scrape token of finding L2; without it `/metrics` wants an admin
    // session, and a session cannot be minted without a database.
    METRICS_TOKEN: "scrape-me",
  });
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({ config });
    // Shape of a Drizzle failure: the SQL and its params in the message, the
    // pg error (SQLSTATE and all) in `cause`. Registered here because routes
    // cannot be added once the app is ready.
    app.get("/__boom", async () => {
      throw new Error(
        'Failed query: select "users"."id" from "sessions" where "sid_hash" = $1 limit $2\nparams: 8ae4ab,1',
        {
          cause: Object.assign(
            new Error("terminating connection due to administrator command"),
            { code: "57P01" },
          ),
        },
      );
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it("healthz answers 503 degraded when the database is unreachable", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: "degraded",
      // The default runner is the stub: reported as disabled, never as a
      // failure, so a machine without a container engine stays healthy.
      checks: { database: "down", runner: "disabled" },
    });
  });

  it("healthz carries coarse words only, and only the database decides its status (ADR-055)", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    const body = HealthResponse.parse(res.json());
    // No ticker in `WORKER_MODE=web`, no backup report configured: neither
    // is a failure, and neither raises the external probe's alarm.
    expect(body.checks).toMatchObject({ ticker: "none", backup: "unknown" });
    expect(body.attention).toBe(false);
    expect(Object.keys(body).sort()).toEqual(["attention", "checks", "status", "uptimeSeconds"]);
    expect(res.body).not.toContain(config.ASSETS_DIR);
  });

  it("a failing route answers a generic 500 and logs the cause", async () => {
    // Fastify logs through a per-request child logger: intercept its creation.
    const logged: Array<{ cause?: { code?: string } }> = [];
    const makeChild = app.log.child.bind(app.log);
    const spy = vi
      .spyOn(app.log, "child")
      .mockImplementation((...args: Parameters<typeof makeChild>) => {
        const child = makeChild(...args);
        child.error = ((entry: { cause?: { code?: string } }) => {
          logged.push(entry);
        }) as typeof child.error;
        return child;
      });

    const res = await app.inject({ method: "GET", url: "/__boom" });
    spy.mockRestore();

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error" });
    // Neither the SQL nor the params reach the browser.
    expect(res.body).not.toContain("Failed query");
    expect(res.body).not.toContain("sid_hash");
    // ... while the pg error behind the Drizzle wrapper is kept in the logs.
    expect(logged.at(-1)?.cause?.code).toBe("57P01");
  });

  /**
   * Finding L2: the scrape endpoint used to be public, and the default
   * collectors publish the command line, the versions and the memory
   * profile of the process.
   */
  it("metrics answers the Prometheus token, and nothing else", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/metrics" });
    expect(anonymous.statusCode).toBe(401);

    const wrong = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(wrong.statusCode).toBe(401);

    const scraped = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${config.METRICS_TOKEN}` },
    });
    expect(scraped.statusCode).toBe(200);
    expect(scraped.body).toContain("quiz_database_up 0");
  });
});

describe("config", () => {
  it("rejects an invalid PORT", () => {
    expect(() => loadConfig({ PORT: "99999" })).toThrow(/Invalid configuration/);
  });
  it("WORKER_MODE defaults to all", () => {
    expect(loadConfig({}).WORKER_MODE).toBe("all");
  });
});

/*
 * The SPA served by the monolith (ADR-009). Nothing exercised this before:
 * STATIC_DIR is empty by default, so the whole branch — @fastify/static and
 * the not-found handler that falls back to index.html — was skipped in tests
 * while production always sets it. A deep link 404ing for every student is
 * exactly the kind of break a @fastify/static major can introduce with the
 * suite still green.
 */
describe("app (serving the built SPA)", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "quiz-static-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>SPA</title>");
    await writeFile(join(dir, "app.js"), "export const x = 1;\n");
    app = await buildApp({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://nobody:nope@127.0.0.1:59999/absent",
    // The database is deliberately absent; pg-boss would answer that by
    // retrying and printing an ECONNREFUSED stack trace per attempt, which
    // says nothing and drowns the output of every other test file.
    JOBS_DISABLED: "1",
    // No background worker either: the ticker would re-read the absent
    // database every second and log one failure per task per tick. What this
    // file is about is the REQUEST path surviving a dead database.
    WORKER_MODE: "web",
        STATIC_DIR: dir,
      }),
    });
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves a built asset from the static root", async () => {
    const res = await app.inject({ method: "GET", url: "/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("export const x = 1;");
  });

  it("falls back to index.html on a deep link, so a reload keeps the page", async () => {
    const res = await app.inject({ method: "GET", url: "/classrooms/c1" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>SPA</title>");
  });

  it("leaves the API surfaces their JSON 404", async () => {
    for (const url of ["/app/api/nope", "/api/nope"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
    }
  });

  it("does not hand the SPA to a non-GET request", async () => {
    const res = await app.inject({ method: "POST", url: "/whatever" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  // N-SEC-02 (#319): the application, not Caddy, sends the policy.
  it("sends the CSP and SAMEORIGIN framing with the SPA, its assets and the API", async () => {
    for (const url of ["/", "/classrooms/c1", "/app.js", "/app/api/nope", "/healthz"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.headers["content-security-policy"], url).toBe(CSP);
      expect(res.headers["x-frame-options"], url).toBe("SAMEORIGIN");
    }
  });

  it("lets Teams frame the tab, and that page only", async () => {
    const tab = await app.inject({ method: "GET", url: "/teams?x=1" });
    expect(tab.headers["content-security-policy"]).toBe(TEAMS_TAB_CSP);
    expect(tab.headers["content-security-policy"]).toMatch(
      /frame-ancestors [^;]*https:\/\/teams\.microsoft\.com/,
    );
    expect(tab.headers["x-frame-options"]).toBeUndefined();
    const link = await app.inject({ method: "GET", url: "/teams/link" });
    expect(link.headers["content-security-policy"]).toBe(CSP);
  });

  it("admits no inline script, no eval and no third party, and falls back to self", () => {
    const directives = new Map(CSP.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'self'"]);
  });
});
