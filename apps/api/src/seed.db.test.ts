/**
 * `pnpm seed` builds its demo vocabulary of concepts (ADR-081) through the
 * concept service and classifies the demo questions with it: every concept
 * validated with both labels, every question exercising its concepts, and a
 * second run that creates nothing.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { concepts, questionConcepts, questions } from "./db/schema.js";
import { seed } from "./seed.js";
import { CONCEPTS, POOLS } from "./seed/content.js";
import { testDb } from "./test/db.js";

describe("the demo seed's concepts", () => {
  it("creates the vocabulary validated, links the questions, and is idempotent", async () => {
    const db = await testDb();
    await seed(db, () => {});

    const vocabulary = await db.select().from(concepts);
    expect(vocabulary).toHaveLength(CONCEPTS.length);
    expect(vocabulary.every((c) => c.status === "validated" && c.labelFr && c.labelEn)).toBe(true);

    const spec = POOLS[0]!.questions[0]!;
    const [row] = await db.select().from(questions).where(eq(questions.internalName, spec.internalName));
    const linked = await db
      .select({ label: concepts.labelFr })
      .from(questionConcepts)
      .innerJoin(concepts, eq(concepts.id, questionConcepts.conceptId))
      .where(eq(questionConcepts.questionId, row!.id));
    expect(linked.map((c) => c.label).sort()).toEqual([...spec.concepts].sort());

    const links = (await db.select().from(questionConcepts)).length;
    await seed(db, () => {});
    expect(await db.select().from(concepts)).toHaveLength(CONCEPTS.length);
    expect(await db.select().from(questionConcepts)).toHaveLength(links);
  }, 120_000);
});
