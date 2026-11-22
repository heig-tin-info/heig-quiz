/**
 * The new periods of the reconciliations (`0155_reconcile_follows_activity`,
 * ADR-011's addendum of 2026-11-22), read from the shipped SQL: a row that
 * still holds its old default moves to the new one; a period an
 * administrator set by hand stays; the other tasks are left alone.
 */
import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { testDatabase } from "../test/db.js";
import { scheduledTasks } from "./schema.js";

const MIGRATION = new URL("../../drizzle/0155_reconcile_follows_activity.sql", import.meta.url);

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  database = await testDatabase();
});

/** The tasks' periods after the migration ran on `periods`. */
async function migrated(periods: Record<string, number>): Promise<Map<string, number>> {
  const { db, client } = database;
  await db.delete(scheduledTasks);
  await db.insert(scheduledTasks).values(Object.entries(periods).map(([key, intervalMinutes]) => ({ key, intervalMinutes })));
  for (const statement of readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")) await client.exec(statement);
  const rows = await db.select({ key: scheduledTasks.key, minutes: scheduledTasks.intervalMinutes }).from(scheduledTasks);
  return new Map(rows.map((r) => [r.key, r.minutes]));
}

describe("0155_reconcile_follows_activity", () => {
  it("moves the rows still at their old default: deliveries every 15 minutes, grades daily", async () => {
    const after = await migrated({ "reconcile.deliveries": 1440, "reconcile.grades": 15, "reconcile.repos": 1440, "deliveries.purge": 1440 });
    expect(Object.fromEntries(after)).toEqual({
      "reconcile.deliveries": 15,
      "reconcile.grades": 1440,
      "reconcile.repos": 1440,
      "deliveries.purge": 1440,
    });
  });

  it("keeps a period an administrator set by hand", async () => {
    const after = await migrated({ "reconcile.deliveries": 60, "reconcile.grades": 30 });
    expect(Object.fromEntries(after)).toEqual({ "reconcile.deliveries": 60, "reconcile.grades": 30 });
  });
});
