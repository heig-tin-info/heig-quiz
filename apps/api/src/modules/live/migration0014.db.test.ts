/**
 * The data step of migration 0014 (issue #89): `marked_done` now means
 * VALIDATED, so a `true` left by the old "Mark as done" in a `free`
 * evaluation is reset, and the rows of the locking navigations are kept.
 *
 * The migrations have already run when `testDb()` returns, on an empty
 * database, so the step is replayed here: the UPDATE is read from the
 * migration file itself — the exact SQL production runs — and executed on
 * rows written through the ordinary services.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { TestClock } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { answers } from "../../db/schema.js";
import { testDb } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, itemRows } from "../evaluation/service.js";
import * as service from "./service.js";

let db: Db;
let restore: () => void;
const clock = new TestClock("2026-09-25T08:00:00.000Z");

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = (await testDb()) as unknown as Db;
});
afterAll(() => restore());

/** The UPDATE of the migration, statement for statement. */
function dataStep(): string {
  const file = fileURLToPath(new URL("../../../drizzle/0014_answer_skip_flag.sql", import.meta.url));
  const statements = readFileSync(file, "utf8").split("--> statement-breakpoint");
  const update = statements.find((s) => /UPDATE "answers"/.test(s));
  if (!update) throw new Error("migration 0014 has no data step");
  return update;
}

/** One answered item marked done in an evaluation of `navigation`. */
async function doneAnswer(navigation: "free" | "forward_only" | "milestones"): Promise<string> {
  const seed = await seedLive(db, { questions: 2, settings: { navigation } });
  const evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", clock.now());
  const participant = (await service.participantOf(db, evaluation, seed.studentIds[0]!))!;
  const created = await service.ensureAttempt(db, evaluation, participant, clock.now());
  const attempt = await service.beginAttempt(db, evaluation, created, participant, clock.now());
  const itemId = (await itemRows(db, evaluation.id))[0]!.id;
  const now = clock.now();
  await service.saveAnswer(db, { evaluation, attempt, itemId, payload: "x", revision: 1, now });
  await service.markDone(db, { evaluation, attempt, itemId, done: true, now });
  const [row] = await db.select().from(answers).where(eq(answers.itemId, itemId));
  expect(row!.markedDone).toBe(true);
  return row!.id;
}

const markedDone = async (id: string) =>
  (await db.select().from(answers).where(eq(answers.id, id)))[0]!.markedDone;

describe("migration 0014, the data step", () => {
  it("resets marked_done in a free evaluation and keeps it in the locking ones", async () => {
    const free = await doneAnswer("free");
    const forward = await doneAnswer("forward_only");
    const milestones = await doneAnswer("milestones");

    await db.execute(sql.raw(dataStep()));

    expect(await markedDone(free)).toBe(false);
    expect(await markedDone(forward)).toBe(true);
    expect(await markedDone(milestones)).toBe(true);
  });
});
