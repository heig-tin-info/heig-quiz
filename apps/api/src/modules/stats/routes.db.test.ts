/**
 * The routes of the question statistics (ADR-038): who may read them, who may
 * reset them, and what the reset leaves behind.
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { answers, attempts, auditLog, poolMembers } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive, type Seeded } from "../../test/live.js";
import { writeGrading } from "../grading/service.js";

type Session = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let restore: () => void;
let seed: Seeded;
let owner: Session;
let reader: Session;
let contributor: Session;
let stranger: Session;
let student: Session;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  owner = await server.signIn("teacher");
  reader = await server.signIn("teacher");
  contributor = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  student = await server.signIn("student");
  seed = await seedLive(server.app.db, { teacherId: owner.id, students: 10 });
  await server.app.db.insert(poolMembers).values([
    { poolId: seed.poolId, userId: reader.id, role: "reader" },
    { poolId: seed.poolId, userId: contributor.id, role: "contributor" },
  ]);
  // Ten answers started before the reset, each a minute on screen: enough
  // to be shown, the time included.
  for (const userId of seed.studentIds) {
    const attemptId = randomUUID();
    await server.app.db.insert(attempts).values({
      id: attemptId,
      evaluationId: seed.evaluationId,
      userId,
      seed: 1,
      state: "submitted",
      startedAt: new Date(server.clock.now().getTime() - 3_600_000),
    });
    await server.app.db.insert(answers).values({
      id: randomUUID(),
      attemptId,
      itemId: seed.itemIds[0]!,
      payload: sql`'null'::jsonb`,
      firstShownAt: server.clock.now(),
      dwellMs: 60_000,
    });
    await writeGrading(server.app.db, {
      attemptId,
      itemId: seed.itemIds[0]!,
      answerId: null,
      points: 1,
      maxPoints: 1,
      source: "manual",
      state: "validated",
      now: server.clock.now(),
    });
  }
});

afterAll(async () => {
  await server.close();
  restore();
});

const get = (url: string, who: Session) => server.app.inject({ method: "GET", url, headers: who.headers });
const reset = (who: Session) =>
  server.app.inject({
    method: "POST",
    url: `/app/api/questions/${seed.questionIds[0]}/stats/reset`,
    headers: who.headers,
  });

describe("reading the statistics", () => {
  it("serves anyone who reads the pool, and hides the pool from everyone else", async () => {
    const url = `/app/api/pools/${seed.poolId}/question-stats`;
    expect((await get(url, stranger)).statusCode).toBe(404);
    expect((await get(url, student)).statusCode).toBe(403);
    const res = await get(url, reader);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        {
          questionId: seed.questionIds[0],
          n: 10,
          p: 1,
          since: null,
          time: { n: 10, meanS: 60, medianS: 60, p25S: 60, p75S: 60 },
        },
      ],
    });
  });
});

describe("resetting the statistics (F-STAT-05)", () => {
  it("is refused to a stranger (404) and to a reader (403)", async () => {
    expect((await reset(stranger)).statusCode).toBe(404);
    const refused = await reset(reader);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "forbidden", role: "reader" });
  });

  it("starts the statistics again from the server's now, audited", async () => {
    const res = await reset(contributor);
    expect(res.statusCode).toBe(200);
    const since = server.clock.now().toISOString();
    expect(res.json()).toEqual({ since });

    const [row] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "question.stats_reset"), eq(auditLog.subjectId, seed.questionIds[0]!)));
    expect(row).toMatchObject({ actorUserId: contributor.id, payload: { poolId: seed.poolId, previousSince: null } });

    expect((await get(`/app/api/pools/${seed.poolId}/question-stats`, owner)).json()).toEqual({ items: [] });
  });
});
