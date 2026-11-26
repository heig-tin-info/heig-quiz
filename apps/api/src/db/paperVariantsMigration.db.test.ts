/**
 * The backfill of `0164_paper_variants` (ADR-148, decision 2), read from the
 * shipped SQL: its last statement, run on evaluations printed before paper
 * variants. Every stored `paper_seed` becomes variant 1 with no values (a
 * parameterized evaluation did not print before); an evaluation never
 * printed gets nothing; a variant already there is kept, so the statement
 * may run twice.
 */
import { readFileSync } from "node:fs";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { testDatabase } from "../test/db.js";
import { seedLive } from "../test/live.js";
import { evaluations, paperVariants } from "./schema.js";

const MIGRATION = new URL("../../drizzle/0164_paper_variants.sql", import.meta.url);

let client: PGlite;
const ids = { printed: "", never: "", already: "" };

beforeAll(async () => {
  const database = await testDatabase();
  client = database.client;
  const { db } = database;
  for (const key of Object.keys(ids) as (keyof typeof ids)[]) {
    ids[key] = (await seedLive(db, { students: 0, questions: 0 })).evaluationId;
  }
  await db.update(evaluations).set({ paperSeed: 1234567 }).where(eq(evaluations.id, ids.printed));
  await db.update(evaluations).set({ paperSeed: 7654321 }).where(eq(evaluations.id, ids.already));
  await db.insert(paperVariants).values({ evaluationId: ids.already, number: 1, seed: 42 });
  // The backfill alone, as shipped: the last statement of the migration, twice.
  const statements = readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint");
  await client.exec(statements.at(-1)!);
  await client.exec(statements.at(-1)!);
});

describe("0164_paper_variants' backfill", () => {
  it("makes every stored paper seed variant 1, with no values, and touches nothing else", async () => {
    const { rows } = await client.query<{ evaluation_id: string; number: number; seed: number; instances: unknown }>(
      `SELECT "evaluation_id", "number", "seed", "instances" FROM "paper_variants" WHERE "evaluation_id" = ANY($1)`,
      [Object.values(ids)],
    );
    const byId = new Map(rows.map((row) => [row.evaluation_id, row]));
    expect(rows).toHaveLength(2);
    expect(byId.get(ids.printed)).toEqual({ evaluation_id: ids.printed, number: 1, seed: 1234567, instances: {} });
    expect(byId.get(ids.already)).toMatchObject({ number: 1, seed: 42 });
    expect(byId.has(ids.never)).toBe(false);
  });
});
