/**
 * In-memory Postgres for DB-dependent tests: PGlite + the real drizzle
 * migrations (the exact SQL production runs at start, MIGRATE_ON_START).
 * `testApp()` returns a minimal FastifyInstance stub carrying `db` and a
 * silent logger — enough for the modules under test.
 */
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";

import { TestClock } from "../clock.js";
import * as schema from "../db/schema.js";
import { UnavailableRunner } from "../modules/runner/unavailable.js";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export async function testDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
  return db;
}

const silent = () => {};

/**
 * Minimal app stub for functions that take a FastifyInstance.
 *
 * It carries a {@link TestClock}: the live tasks of the ticker read
 * `app.clock.now()`, so a test drives a deadline by moving one object rather
 * than by sleeping (invariant 5).
 */
export async function testApp(
  existing?: TestDb,
): Promise<FastifyInstance & { db: TestDb; clock: TestClock }> {
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
    log: { info: silent, warn: silent, error: silent, debug: silent },
  } as unknown as FastifyInstance & { db: TestDb; clock: TestClock };
}
