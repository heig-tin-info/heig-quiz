/**
 * The pg-boss check against a REAL PostgreSQL (N-OPS-03, ADR-055): the
 * SQL on the `pgboss` schema cannot run on PGlite, so this is where a
 * pg-boss upgrade that reshapes `pgboss.job` shows up before production.
 *
 * Skipped unless `TEST_PG_URL` names a disposable database, e.g. the one
 * of `docker-compose.dev.yml`:
 *
 *   TEST_PG_URL=postgres://quiz:quiz@localhost:5432/quiz \
 *     pnpm --filter @quiz/api test -- src/modules/system/health.pg.test.ts
 *
 * It creates its own queues, named after a random suffix, and deletes them.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SystemCheck } from "@quiz/contracts";

import { loadConfig } from "../../config.js";
import { createDb } from "../../db/client.js";
import { TestClock } from "../../clock.js";
import { HEALTH_CHECKS, runChecks } from "./health.js";

const url = process.env.TEST_PG_URL ?? "";

describe.skipIf(!url.startsWith("postgres"))("the jobs check on a real pg-boss", () => {
  const suffix = randomUUID().slice(0, 8);
  const ok = `health-ok-${suffix}`;
  const broken = `health-broken-${suffix}`;
  let boss: PgBoss;
  let handle: ReturnType<typeof createDb>;
  let app: FastifyInstance;

  beforeAll(async () => {
    boss = new PgBoss({ connectionString: url });
    await boss.start();
    await boss.createQueue(ok);
    await boss.createQueue(broken, { retryLimit: 0 } as never);
    handle = createDb(url);
    app = {
      db: handle.db,
      clock: new TestClock(),
      // Any queue but the in-process one: the check reads the table itself.
      boss: { send: async () => {} },
      log: { warn: () => {} },
    } as unknown as FastifyInstance;
  });

  afterAll(async () => {
    await boss?.deleteQueue(ok).catch(() => {});
    await boss?.deleteQueue(broken).catch(() => {});
    await boss?.stop({ close: true });
    await handle?.close();
  });

  it("counts the waiting and the failed jobs of each queue, and the oldest wait", async () => {
    await boss.send(ok, { n: 1 });
    await boss.send(ok, { n: 2 });
    await boss.send(broken, { n: 3 }, { retryLimit: 0 });
    const [job] = await boss.fetch(broken);
    await boss.fail(broken, job!.id);

    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: url });
    const [jobs] = await runChecks(app, config, HEALTH_CHECKS.filter((c) => c.key === "jobs"));
    const check = SystemCheck.parse(jobs);
    // The query ran: a drifted schema would read `unknown`, `check.failed`.
    expect(check.cause).not.toBe("check.failed");
    expect(check.status).toBe("warn");
    expect(check.cause).toBe("jobs.failed");

    const line = (name: string) =>
      check.details.find((d) => d.subject.kind === "name" && d.subject.name === name);
    expect(line(ok)?.values).toEqual([
      { meaning: "waiting", value: { kind: "count", n: 2 } },
      { meaning: "failed", value: { kind: "count", n: 0 } },
      { meaning: "oldest", value: { kind: "duration", ms: expect.any(Number) } },
    ]);
    expect(line(broken)?.values).toEqual([
      { meaning: "waiting", value: { kind: "count", n: 0 } },
      { meaning: "failed", value: { kind: "count", n: 1 } },
    ]);
  });
});
