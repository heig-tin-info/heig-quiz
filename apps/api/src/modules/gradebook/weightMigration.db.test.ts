/**
 * The migration of a gradebook column's weight from a 0–10 coefficient to a
 * whole percentage (`0089_gradebook_weight_percent`, #545, ADR-074 amendment
 * of 2026-10-08), read from the shipped SQL: the test runs the statements
 * that really run, on a table put back in its old shape.
 *
 * What it pins: relative weights are kept per classroom — the largest weight,
 * the old default 1 included, becomes 100 % — and in a classroom where a
 * coefficient exceeded 1, the activities that had no stored column (worth 1)
 * are stored at their normalised weight rather than jumping to the new
 * default 100 %.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../../db/client.js";
import { evaluations, gradebookColumns } from "../../db/schema.js";
import { testDatabase } from "../../test/db.js";
import { seedLive } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";

const MIGRATION = new URL("../../../drizzle/0089_gradebook_weight_percent.sql", import.meta.url);

let db: Db;
let client: PGlite;

/** The table as it was before the migration: `numeric(3,1)`, 0 to 10, no default. */
async function oldShape(): Promise<void> {
  await client.exec(`
    ALTER TABLE "gradebook_columns" DROP CONSTRAINT "gradebook_columns_weight_range";
    ALTER TABLE "gradebook_columns" ALTER COLUMN "weight" DROP DEFAULT;
    ALTER TABLE "gradebook_columns" ALTER COLUMN "weight" SET DATA TYPE numeric(3, 1);
    ALTER TABLE "gradebook_columns" ADD CONSTRAINT "gradebook_columns_weight_range" CHECK ("weight" >= 0 AND "weight" <= 10);
  `);
}

async function migrate(): Promise<void> {
  for (const statement of readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")) await client.exec(statement);
}

/** A classroom with an evaluation per entry, in the given mode and state. */
async function classroomWith(specs: { mode: "exam" | "exercise"; state: "closed" | "draft" }[]) {
  const seeded = await seedLive(db, { students: 0, questions: 0 });
  await db.delete(evaluations).where(eq(evaluations.id, seeded.evaluationId));
  const ids: string[] = [];
  for (const [i, spec] of specs.entries()) {
    const created = await evaluationService.createEvaluation(db, { classroomId: seeded.classroomId, title: `E${i}`, mode: spec.mode, createdBy: seeded.teacherId });
    await db.update(evaluations).set({ state: spec.state }).where(eq(evaluations.id, created.id));
    ids.push(created.id);
  }
  return { classroomId: seeded.classroomId, ids };
}

const store = (classroomId: string, evaluationId: string, weight: number, counts = true) =>
  db.insert(gradebookColumns).values({ id: randomUUID(), classroomId, evaluationId, weight, counts, updatedAt: new Date() });

const weightsOf = async (classroomId: string) =>
  new Map(
    (await db.select().from(gradebookColumns).where(eq(gradebookColumns.classroomId, classroomId))).map((row) => [
      row.evaluationId!,
      { weight: Number(row.weight), counts: row.counts },
    ]),
  );

let doubled: Awaited<ReturnType<typeof classroomWith>>;
let small: Awaited<ReturnType<typeof classroomWith>>;
let uneven: Awaited<ReturnType<typeof classroomWith>>;

beforeAll(async () => {
  ({ db, client } = await testDatabase());
  await oldShape();
  // A 2 next to a 1, an exam and an exercise with no stored column (worth 1), and a draft (no column at all).
  doubled = await classroomWith([
    { mode: "exam", state: "closed" },
    { mode: "exam", state: "closed" },
    { mode: "exam", state: "closed" },
    { mode: "exercise", state: "closed" },
    { mode: "exam", state: "draft" },
  ]);
  await store(doubled.classroomId, doubled.ids[0]!, 2);
  await store(doubled.classroomId, doubled.ids[1]!, 1);
  // Nothing above the old default: times 100, and the column nobody stored keeps the default.
  small = await classroomWith([
    { mode: "exam", state: "closed" },
    { mode: "exam", state: "closed" },
    { mode: "exam", state: "closed" },
  ]);
  await store(small.classroomId, small.ids[0]!, 1);
  await store(small.classroomId, small.ids[1]!, 0.5, false);
  // A 3 next to a 0.5 and a 0: rounded to the whole percent.
  uneven = await classroomWith([
    { mode: "exam", state: "closed" },
    { mode: "exam", state: "closed" },
    { mode: "exam", state: "closed" },
  ]);
  await store(uneven.classroomId, uneven.ids[0]!, 3);
  await store(uneven.classroomId, uneven.ids[1]!, 0.5);
  await store(uneven.classroomId, uneven.ids[2]!, 0);
  await migrate();
});

describe("the weight migration to percentages (#545)", () => {
  it("makes the classroom's largest weight 100 % and keeps the others in proportion", async () => {
    const weights = await weightsOf(doubled.classroomId);
    expect(weights.get(doubled.ids[0]!)).toEqual({ weight: 100, counts: true });
    expect(weights.get(doubled.ids[1]!)).toEqual({ weight: 50, counts: true });
  });

  it("stores the activities that had no column at their normalised weight, with their kind's counted flag", async () => {
    const weights = await weightsOf(doubled.classroomId);
    expect(weights.get(doubled.ids[2]!)).toEqual({ weight: 50, counts: true });
    expect(weights.get(doubled.ids[3]!)).toEqual({ weight: 50, counts: false });
    // A draft has no gradebook column.
    expect(weights.has(doubled.ids[4]!)).toBe(false);
  });

  it("multiplies by 100 a classroom whose weights never exceeded 1, and stores nothing new there", async () => {
    const weights = await weightsOf(small.classroomId);
    expect(weights.get(small.ids[0]!)).toEqual({ weight: 100, counts: true });
    expect(weights.get(small.ids[1]!)).toEqual({ weight: 50, counts: false });
    expect(weights.has(small.ids[2]!)).toBe(false);
  });

  it("rounds to the whole percent, and keeps a 0", async () => {
    const weights = await weightsOf(uneven.classroomId);
    expect([uneven.ids[0], uneven.ids[1], uneven.ids[2]].map((id) => weights.get(id!)!.weight)).toEqual([100, 17, 0]);
  });

  it("leaves an integer column, 100 by default, refusing anything above 100", async () => {
    const id = randomUUID();
    await client.query(`INSERT INTO "gradebook_columns" ("id", "classroom_id", "evaluation_id", "counts", "updated_at") VALUES ($1, $2, $3, true, now())`, [
      id,
      small.classroomId,
      small.ids[2],
    ]);
    const [row] = await db.select().from(gradebookColumns).where(eq(gradebookColumns.id, id));
    expect(row!.weight).toBe(100);
    await expect(db.update(gradebookColumns).set({ weight: 101 }).where(eq(gradebookColumns.id, id))).rejects.toThrow();
  });
});
