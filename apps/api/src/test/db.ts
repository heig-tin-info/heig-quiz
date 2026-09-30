/**
 * In-memory Postgres for DB-dependent tests: PGlite + the real drizzle
 * migrations (the exact SQL production runs at start, MIGRATE_ON_START),
 * applied once per run and copied for each caller (test/template.ts).
 * `testApp()` returns a minimal FastifyInstance stub carrying `db` and a
 * silent logger — enough for the modules under test.
 */
import type { PGlite } from "@electric-sql/pglite";
import type { Logger } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { FastifyInstance } from "fastify";

import { TestClock } from "../clock.js";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { UnavailableRunner } from "../modules/runner/unavailable.js";
import { migratedPglite } from "./template.js";

/**
 * A PGlite client seen as the application's {@link Db}: the very view
 * `createDb` gives a `pglite://` URL, so the modules under test receive the
 * type they declare. `logger` lets a test see every statement a call sends.
 */
export function pgliteDb(client: PGlite, logger?: Logger): Db {
  return drizzle(client, { schema, ...(logger ? { logger } : {}) }) as unknown as Db;
}

/**
 * A migrated in-memory database, with its PGlite client for the tests that
 * spy on the driver underneath (statements, transactions).
 */
export async function testDatabase(): Promise<{ db: Db; client: PGlite }> {
  // The production wiring of `buildApp`: the drill's hooks on the release and
  // the end of an attempt, so no db test depends on what it happens to import.
  // Imported here, at the call, and not at the top of this file: the drill
  // service pulls in `results`, `live` and `notifications`, and a test file
  // that mocks one of them (`vi.mock`) must have finished loading first.
  const { registerDrillHooks } = await import("../modules/drill/service.js");
  registerDrillHooks();
  const client = await migratedPglite();
  return { db: pgliteDb(client), client };
}

export async function testDb(): Promise<Db> {
  return (await testDatabase()).db;
}

const silent = () => {};

/**
 * Minimal app stub for functions that take a FastifyInstance.
 *
 * It carries a {@link TestClock}: the live tasks of the ticker read
 * `app.clock.now()`, so a test drives a deadline by moving one object rather
 * than by sleeping (invariant 5).
 */
export async function testApp(existing?: Db): Promise<FastifyInstance & { clock: TestClock }> {
  const db = existing ?? (await testDb());
  return {
    db,
    // No queue: the grading pass runs inline at the call site, which is what
    // makes a job assertable without a timer (see `modules/grading/jobs.ts`).
    boss: null,
    clock: new TestClock(),
    // The default runner everywhere (decision D14). A test that wants
    // outcomes assigns its own double to `app.runner`.
    runner: new UnavailableRunner("test"),
    // No LLM provider, as in production; a test that wants one assigns it.
    llm: null,
    log: { info: silent, warn: silent, error: silent, debug: silent },
  } as unknown as FastifyInstance & { clock: TestClock };
}
