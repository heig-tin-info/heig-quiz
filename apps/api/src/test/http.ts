/**
 * A REAL application over an embedded database, for the route tests: the
 * whole plugin chain, the real guards, the real session cookies. Anything
 * less would test a stub of the API rather than the API.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance, InjectOptions } from "fastify";

import { CSRF_COOKIE } from "@quiz/contracts";
import type { UserRole } from "@quiz/contracts";

import { buildApp } from "../app.js";
import { TestClock } from "../clock.js";
import { SESSION_COOKIE, createSession } from "../auth/session.js";
import { loadConfig } from "../config.js";
import { users } from "../db/schema.js";
import { migratedPglite } from "./template.js";

/**
 * A request body `app.inject` accepts. The inject helpers of the route tests
 * take `payload?: Payload` and spread it only when present: under
 * `exactOptionalPropertyTypes`, neither `unknown` nor an explicit `undefined`
 * fits `InjectOptions`.
 */
export type Payload = NonNullable<InjectOptions["payload"]>;

export interface TestServer {
  app: FastifyInstance;
  assetsDir: string;
  /** The server clock, moved by hand: no test ever sleeps (invariant 5). */
  clock: TestClock;
  /** Creates an account and returns the headers that authenticate it. */
  signIn: (
    role: UserRole,
    email?: string,
  ) => Promise<{ id: string; headers: Record<string, string> }>;
  /**
   * An admin whose session has switched Super Powers on (ADR-054), through
   * the real route: the caller for a test about reaching everyone's
   * content. An admin from `signIn` reaches what a teacher reaches.
   */
  signInWithSuperPowers: (email?: string) => Promise<{ id: string; headers: Record<string, string> }>;
  close: () => Promise<void>;
}

/** `env` adds to (or overrides) the test configuration, e.g. the `TEAMS_*` variables. */
export async function testServer(env: Record<string, string> = {}): Promise<TestServer> {
  const clock = new TestClock();
  const dir = await mkdtemp(join(tmpdir(), "quiz-api-"));
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: `pglite://${join(dir, "db")}`,
    ASSETS_DIR: join(dir, "assets"),
    // No ticker and no job worker: a route test must not race a background
    // loop it did not ask for.
    WORKER_MODE: "web",
    // No job queue either: nothing under test enqueues one, and a queue that
    // is not started cannot print a connection failure (see config.ts).
    JOBS_DISABLED: "1",
    LOG_LEVEL: "fatal",
    ...env,
  });
  // The real migration chain, as `server.ts` applies it at boot, run once
  // per test run and copied into this server's directory (test/template.ts).
  await (await migratedPglite(join(dir, "db"))).close();

  const app = await buildApp({ config, clock });
  await app.ready();

  const server: TestServer = {
    app,
    assetsDir: config.ASSETS_DIR,
    clock,
    async signIn(role, email = `${role}-${randomUUID().slice(0, 8)}@heig.test`) {
      const id = randomUUID();
      await app.db.insert(users).values({
        id,
        oidcSub: `test-${id}`,
        email,
        emailVerified: true,
        givenName: "Test",
        familyName: role,
        role,
      });
      const session = await createSession(app.db, id, config.SESSION_TTL_HOURS);
      return {
        id,
        headers: {
          cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${session.csrf}`,
          "x-csrf-token": session.csrf,
        },
      };
    },
    async signInWithSuperPowers(email) {
      const admin = await server.signIn("admin", email);
      const res = await app.inject({ method: "POST", url: "/app/api/me/super-powers", headers: admin.headers });
      if (res.statusCode !== 200) throw new Error(`super powers refused: ${res.statusCode} ${res.body}`);
      return admin;
    },
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return server;
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Every (method, path) of Fastify's route tree (`printRoutes({ commonPrefix:
 * false })`), HEAD aside: what the tests that probe EVERY route walk — a
 * `seb` session answering like nobody (ADR-027), an impersonation refused
 * every write (ADR-034).
 */
export function routesOf(tree: string): { method: Method; path: string }[] {
  const stack: string[] = [];
  return tree.split("\n").flatMap((line) => {
    const match = /^(.*?)[├└]── (\S+) \(([^)]+)\)/.exec(line);
    if (!match) return [];
    const depth = match[1]!.length / 4;
    stack.length = depth;
    stack.push(match[2]!);
    const path = stack.join("");
    return match[3]!
      .split(", ")
      .filter((m) => m !== "HEAD")
      .map((method) => ({ method: method as Method, path }));
  });
}
