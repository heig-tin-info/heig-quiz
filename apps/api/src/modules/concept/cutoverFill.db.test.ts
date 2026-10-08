/**
 * The fill of the cut-over from tags to concepts (`0092_concept_cutover_fill`,
 * ADR-081 third addendum §2), read from the shipped SQL: the test runs the
 * statement that really runs, on links emptied first.
 *
 * What it pins: every live question gets the concepts its (pool, tag) pairs
 * were accepted into, following `merged_into`; a pair dropped, merely
 * proposed or never sorted links nothing; the same tag in another pool
 * follows that pool's decision (a homonym); a deleted question gets nothing;
 * and replaying the statement changes nothing.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../../db/client.js";
import { concepts, conceptTagSortings, pools, questionConcepts, questions, questionTags, users } from "../../db/schema.js";
import { testDatabase } from "../../test/db.js";

const MIGRATION = new URL("../../../drizzle/0092_concept_cutover_fill.sql", import.meta.url);

let db: Db;
let client: PGlite;
let ownerId: string;

async function fill(): Promise<void> {
  for (const statement of readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")) await client.exec(statement);
}

async function pool(name: string): Promise<string> {
  const id = randomUUID();
  await db.insert(pools).values({ id, name, ownerId });
  return id;
}

/** A question of `poolId` wearing `tags`, deleted when asked. */
async function question(poolId: string, tags: string[], deleted = false): Promise<string> {
  const id = randomUUID();
  await db.insert(questions).values({
    id,
    poolId,
    type: "short",
    internalName: `q-${id.slice(0, 8)}`,
    createdBy: ownerId,
    deletedAt: deleted ? new Date() : null,
  });
  if (tags.length) await db.insert(questionTags).values(tags.map((tag) => ({ questionId: id, tag })));
  return id;
}

async function concept(label: string, mergedInto: string | null = null): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(concepts).values({
    id,
    status: mergedInto ? "merged" : "validated",
    mergedInto,
    labelFr: label,
    keyFr: `${label}-fr`,
    labelEn: label,
    keyEn: `${label}-en`,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

const decided = { decidedAt: new Date() };
const linksOf = async (questionId: string) =>
  (await db.select().from(questionConcepts).where(eq(questionConcepts.questionId, questionId)))
    .map((l) => l.conceptId)
    .sort();

beforeAll(async () => {
  ({ db, client } = await testDatabase());
  ownerId = randomUUID();
  await db.insert(users).values({ id: ownerId, oidcSub: `s-${ownerId}`, email: "fill@heig.test", role: "teacher" });
});

describe("the cut-over fill (0092)", () => {
  it("links the live questions to the concepts their pairs were accepted into", async () => {
    const memory = await pool("Memory");
    const power = await pool("Power");
    const pointer = await concept("pointer");
    const stackFinal = await concept("call stack");
    const stackOld = await concept("stack-old", stackFinal);
    const battery = await concept("battery");

    const both = await question(memory, ["pointeur", "pile", "semaine3"]);
    const proposedOnly = await question(memory, ["boucle"]);
    const unsorted = await question(memory, ["tardif"]);
    const deleted = await question(memory, ["pointeur"], true);
    const homonym = await question(power, ["pile"]);

    await db.insert(conceptTagSortings).values([
      { poolId: memory, tag: "pointeur", decision: "concept", conceptId: pointer, ...decided },
      // Accepted before the merge: the fill follows `merged_into` to the final concept.
      { poolId: memory, tag: "pile", decision: "concept", conceptId: stackOld, ...decided },
      { poolId: memory, tag: "semaine3", decision: "drop", dropReason: "organisational", ...decided },
      { poolId: memory, tag: "boucle", proposal: { model: "m", kind: "concept", conceptId: pointer } },
      // The same tag in another pool: another concept (a homonym, second addendum §1).
      { poolId: power, tag: "pile", decision: "concept", conceptId: battery, ...decided },
    ]);

    await fill();

    expect(await linksOf(both)).toEqual([pointer, stackFinal].sort());
    expect(await linksOf(proposedOnly)).toEqual([]);
    expect(await linksOf(unsorted)).toEqual([]);
    expect(await linksOf(deleted)).toEqual([]);
    expect(await linksOf(homonym)).toEqual([battery]);

    // Replaying it is harmless, and keeps a link a teacher added since.
    await db.insert(questionConcepts).values({ questionId: unsorted, conceptId: pointer });
    const before = await db.select().from(questionConcepts);
    await fill();
    expect((await db.select().from(questionConcepts)).length).toBe(before.length);
    expect(await linksOf(unsorted)).toEqual([pointer]);
  });
});
