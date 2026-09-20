/**
 * A REAL application over an embedded database, for the route tests: the
 * whole plugin chain, the real guards, the real session cookies. Anything
 * less would test a stub of the API rather than the API.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { TestClock } from "../clock.js";
import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "../auth/session.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { users } from "../db/schema.js";
import { MIGRATIONS_DIR } from "../paths.js";

export interface TestServer {
  app: FastifyInstance;
  assetsDir: string;
  /** The server clock, moved by hand: no test ever sleeps (invariant 5). */
  clock: TestClock;
  /** Creates an account and returns the headers that authenticate it. */
  signIn: (
    role: "student" | "teacher" | "admin",
    email?: string,
  ) => Promise<{ id: string; headers: Record<string, string> }>;
  close: () => Promise<void>;
}

export async function testServer(): Promise<TestServer> {
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
  });
  // The real migration chain, exactly as `server.ts` applies it at boot.
  const handle = createDb(config.DATABASE_URL);
  await handle.migrate(MIGRATIONS_DIR);
  await handle.close();

  const app = await buildApp({ config, clock });
  await app.ready();

  return {
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
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
