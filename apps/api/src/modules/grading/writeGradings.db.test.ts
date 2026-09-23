/**
 * The batched writer of the grading pass (D-01): what one pass costs in
 * statements, and the supersede chain `writeGradings` builds for many cells
 * at once. The behaviour of the pass itself is `grading.db.test.ts`.
 */
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import * as schema from "../../db/schema.js";
import { attempts, gradings } from "../../db/schema.js";
import { testApp, testDb, type TestDb } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, joinedItems } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { runEvaluationGrading } from "./jobs.js";
import { writeGradings } from "./service.js";

let raw: TestDb;
let db: Db;
const restores: (() => void)[] = [];

beforeAll(async () => {
  restores.push(registerForTests(fakeShort));
  raw = await testDb();
  db = raw as unknown as Db;
});
afterAll(() => {
  for (const restore of restores) restore();
});

const NOW = new Date("2026-09-20T09:00:00.000Z");

/** A closed evaluation of `students` × `questions` cells; every student answered the first. */
async function closedGrid(students: number, questions: number) {
  const seed = await seedLive(db, { students, questions });
  let evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", NOW);
  const items = await joinedItems(db, evaluation.id);
  const attemptIds: string[] = [];
  for (const [index, userId] of seed.studentIds.entries()) {
    const participant = (await live.participantOf(db, evaluation, userId))!;
    const created = await live.ensureAttempt(db, evaluation, participant, NOW);
    const attempt = await live.beginAttempt(db, evaluation, created, participant, NOW);
    await live.saveAnswer(db, {
      evaluation,
      attempt,
      itemId: items[0]!.item.id,
      payload: index % 2 === 0 ? "answer-q0" : "nope",
      revision: 1,
      now: NOW,
    });
    attemptIds.push(attempt.id);
  }
  evaluation = await live.closeEvaluation(db, evaluation, NOW);
  return { evaluation, items, attemptIds };
}

describe("the grading pass writes in batches (D-01)", () => {
  it("grades 10 × 5 cells in one transaction of two write statements", async () => {
    const { evaluation } = await closedGrid(10, 5);

    // The same database, seen through a drizzle handle that logs every
    // statement, and the driver's transactions counted underneath.
    const statements: string[] = [];
    const logged = drizzle(raw.$client, {
      schema,
      logger: { logQuery: (query) => statements.push(query) },
    });
    const transactions = vi.spyOn(raw.$client, "transaction");
    const app = await testApp(logged);
    app.clock.set(NOW.toISOString());

    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    const transactionCount = transactions.mock.calls.length;
    transactions.mockRestore();

    // Before D-01: 50 transactions, 50 UPDATE + 50 INSERT.
    const writes = statements.filter((s) => /^(update|insert into) "gradings"/i.test(s));
    expect(writes.map((s) => s.split(" ")[0]!.toLowerCase())).toEqual(["update", "insert"]);
    expect(transactionCount).toBe(1);

    const rows = await db
      .select({ grading: gradings })
      .from(gradings)
      .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
      .where(eq(attempts.evaluationId, evaluation.id));
    expect(rows).toHaveLength(50);
    expect(rows.every((r) => r.grading.state === "validated")).toBe(true);
  });
});

describe("writeGradings", () => {
  it("supersedes what stands on each cell and chains to it, never a validated one from a proposal", async () => {
    const { items, attemptIds } = await closedGrid(3, 1);
    const itemId = items[0]!.item.id;
    const cell = (attemptId: string) => ({
      attemptId,
      itemId,
      answerId: null,
      maxPoints: 1,
      source: "auto" as const,
      now: NOW,
    });
    const [a, b, c] = attemptIds as [string, string, string];

    const first = await writeGradings(db, [
      { ...cell(a), points: 0, state: "proposed" },
      { ...cell(b), points: 1, state: "validated" },
    ]);
    expect(first.map((r) => r.supersedesId)).toEqual([null, null]);

    const second = await writeGradings(db, [
      // Validated over a proposal: supersedes it.
      { ...cell(a), points: 1, state: "validated" },
      // A proposal over a validated grade: supersedes nothing.
      { ...cell(b), points: 0, state: "proposed" },
      // A fresh cell.
      { ...cell(c), points: 0, state: "validated" },
    ]);
    expect(second.map((r) => r.attemptId)).toEqual([a, b, c]);
    expect(second.map((r) => r.supersedesId)).toEqual([first[0]!.id, null, null]);

    const stateOf = async (id: string) =>
      (await db.select().from(gradings).where(eq(gradings.id, id)))[0]!.state;
    expect(await stateOf(first[0]!.id)).toBe("superseded");
    expect(await stateOf(first[1]!.id)).toBe("validated");

    const standingOnB = await db
      .select()
      .from(gradings)
      .where(and(eq(gradings.attemptId, b), eq(gradings.itemId, itemId)));
    expect(standingOnB.map((r) => r.state).sort()).toEqual(["proposed", "validated"]);
  });

  it("writes nothing for an empty batch", async () => {
    expect(await writeGradings(db, [])).toEqual([]);
  });
});
