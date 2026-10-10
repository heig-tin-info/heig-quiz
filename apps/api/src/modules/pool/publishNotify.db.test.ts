/**
 * `pool_question_added` (ADR-030, addendum §c; #198 step 5): publishing a
 * question in a pool tells its owner and its `contributor` and `owner`
 * members — never a reader, never the author — folded per pool, so a bulk
 * import is one entry that counts.
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { notifications, poolMembers, pools, questions, users } from "../../db/schema.js";
import { testDb } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import * as poolService from "./service.js";

let db: Db;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = await testDb();
});
afterAll(() => restore());

async function makeUser(role: "teacher" | "admin"): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({ id, oidcSub: `s-${id}`, email: `${role}-${id.slice(0, 8)}@heig.test`, role });
  return id;
}

/** A pool with an owner and one member of each role, and a teacher outside it. */
async function sharedPool() {
  const [owner, coOwner, contributor, reader, outsider] = await Promise.all([
    makeUser("teacher"),
    makeUser("teacher"),
    makeUser("teacher"),
    makeUser("teacher"),
    makeUser("admin"),
  ]);
  const poolId = randomUUID();
  await db.insert(pools).values({ id: poolId, name: "Réseaux", ownerId: owner! });
  await db.insert(poolMembers).values([
    { poolId, userId: coOwner!, role: "owner" },
    { poolId, userId: contributor!, role: "contributor" },
    { poolId, userId: reader!, role: "reader" },
  ]);
  return { poolId, owner: owner!, coOwner: coOwner!, contributor: contributor!, reader: reader!, outsider: outsider! };
}

let counter = 0;
/** A question of the fake `short` type, published by `author`; returns its record. */
async function publish(poolId: string, author: string) {
  counter += 1;
  const { id } = await poolService.createQuestion(db, {
    poolId,
    type: "short",
    internalName: `q-${counter}`,
    createdBy: author,
  });
  const [question] = await db.select().from(questions).where(eq(questions.id, id));
  await poolService.putDraft(db, question!, {
    config: { statement: `Statement ${counter}`, answer: `secret-${counter}` },
  });
  await poolService.publishQuestion(db, question!, { userId: author });
  return question!;
}

const addedRows = (poolId: string) =>
  db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.poolId, poolId),
        sql`${notifications.payload}->>'kind' = 'pool_question_added'`,
      ),
    );

describe("pool_question_added", () => {
  it("tells the owner and the contributor and owner members, never a reader nor the author", async () => {
    const pool = await sharedPool();
    await publish(pool.poolId, pool.contributor);

    const rows = await addedRows(pool.poolId);
    expect(rows.map((r) => r.userId).sort()).toEqual([pool.owner, pool.coOwner].sort());
    for (const row of rows) {
      expect(row.payload).toEqual({
        kind: "pool_question_added",
        poolId: pool.poolId,
        poolName: "Réseaux",
        count: 1,
      });
    }
    // No question content, no answer key, no name.
    expect(JSON.stringify(rows.map((r) => r.payload))).not.toMatch(/Statement|secret|q-\d|@heig/);
  });

  it("tells the contributor when the owner publishes, and nobody of a private pool", async () => {
    const pool = await sharedPool();
    await publish(pool.poolId, pool.owner);
    expect((await addedRows(pool.poolId)).map((r) => r.userId).sort()).toEqual(
      [pool.coOwner, pool.contributor].sort(),
    );

    const lonely = randomUUID();
    await db.insert(pools).values({ id: lonely, name: "Mine", ownerId: pool.owner });
    await publish(lonely, pool.owner);
    expect(await addedRows(lonely)).toEqual([]);
  });

  it("never tells a member demoted to student, nor a demoted owner (#287)", async () => {
    const pool = await sharedPool();
    await db.update(users).set({ role: "student" }).where(inArray(users.id, [pool.owner, pool.coOwner]));
    await publish(pool.poolId, pool.contributor);
    expect(await addedRows(pool.poolId)).toEqual([]);
  });

  it("folds a bulk publication into ONE entry per recipient that counts every question", async () => {
    const pool = await sharedPool();
    for (let i = 0; i < 50; i++) await publish(pool.poolId, pool.contributor);

    const rows = await addedRows(pool.poolId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.readAt).toBeNull();
      expect(row.payload).toMatchObject({ count: 50 });
    }
  });

  it("counts a new version as a publication", async () => {
    const pool = await sharedPool();
    const question = await publish(pool.poolId, pool.contributor);
    await poolService.publishQuestion(db, question, { userId: pool.contributor });
    const [row] = (await addedRows(pool.poolId)).filter((r) => r.userId === pool.owner);
    expect(row!.payload).toMatchObject({ count: 2 });
  });
});
