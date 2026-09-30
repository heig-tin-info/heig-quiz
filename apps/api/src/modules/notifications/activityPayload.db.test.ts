/**
 * The data step of the migration `*_activity_payload_neutral` (merge task
 * M1-03): an `activity_available` bell stored in the evaluation shape of
 * before is rewritten into the kind-neutral one, and stays in the list — whose
 * reader drops a payload that no longer parses.
 *
 * The migrations have already run when `testDb()` returns, on an empty
 * database, so the step is replayed here from the migration file itself — the
 * exact SQL production runs — on a row written in the old shape.
 */
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { notifications } from "../../db/schema.js";
import { testDb } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { seedLive } from "../../test/live.js";
import { listNotifications } from "./service.js";

let db: Db;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = await testDb();
});
afterAll(() => restore());

function dataStep(): string {
  const dir = fileURLToPath(new URL("../../../drizzle/", import.meta.url));
  const name = readdirSync(dir).find((f) => f.endsWith("_activity_payload_neutral.sql"));
  if (!name) throw new Error("no activity_payload_neutral migration");
  return readFileSync(`${dir}${name}`, "utf8");
}

describe("the kind-neutral activity_available payload (migration)", () => {
  it("rewrites a stored row of the old shape, once, and leaves the other kinds alone", async () => {
    const seed = await seedLive(db, { students: 1 });
    const student = seed.studentIds[0]!;
    const old = randomUUID();
    const other = randomUUID();
    const scheduled = {
      kind: "activity_scheduled",
      classroomId: seed.classroomId,
      classroomName: "A",
      count: 2,
    };
    await db.insert(notifications).values([
      {
        id: old,
        userId: student,
        evaluationId: seed.evaluationId,
        payload: { kind: "activity_available", evaluationId: seed.evaluationId, evaluationTitle: "Série 3" },
      },
      { id: other, userId: student, classroomId: seed.classroomId, payload: scheduled },
    ]);
    // Before: the list drops the row it cannot read.
    expect((await listNotifications(db, student)).items.map((n) => n.id)).toEqual([other]);

    await db.execute(sql.raw(dataStep()));
    await db.execute(sql.raw(dataStep()));

    const items = (await listNotifications(db, student)).items;
    expect(items.find((n) => n.id === old)?.payload).toEqual({
      kind: "activity_available",
      activityKind: "evaluation",
      activityId: seed.evaluationId,
      activityTitle: "Série 3",
    });
    expect(items.find((n) => n.id === other)?.payload).toEqual(scheduled);
    const [row] = await db.select().from(notifications).where(eq(notifications.id, old));
    expect(row!.evaluationId).toBe(seed.evaluationId);
  });
});
