/** The tag vocabulary of a pool (`pool_tags`, `question_tags`). */
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { PoolTag } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { poolTags as poolTagsTable, questionTags, questions } from "../../db/schema.js";
import type { Tx } from "./shared.js";

/** The distinct tags used by the live questions of a pool, alphabetical. */
export async function poolTagNames(db: Db, poolId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tag: questionTags.tag })
    .from(questionTags)
    .innerJoin(questions, eq(questionTags.questionId, questions.id))
    .where(and(eq(questions.poolId, poolId), isNull(questions.deletedAt)))
    .orderBy(asc(questionTags.tag));
  return rows.map((r) => r.tag);
}

/**
 * The whole tag vocabulary of a pool, alphabetical: the documented rows of
 * `pool_tags` and, defensively, any tag worn by a question that has no row
 * yet (a pool written before the lazy creation landed and never migrated).
 * `count` only counts the live questions, which is what the teacher sees.
 */
export async function poolTags(db: Db, poolId: string): Promise<PoolTag[]> {
  const [described, used] = await Promise.all([
    db
      .select({ tag: poolTagsTable.tag, description: poolTagsTable.description })
      .from(poolTagsTable)
      .where(eq(poolTagsTable.poolId, poolId)),
    db
      .select({ tag: questionTags.tag, n: sql<number>`count(*)::int` })
      .from(questionTags)
      .innerJoin(questions, eq(questionTags.questionId, questions.id))
      .where(and(eq(questions.poolId, poolId), isNull(questions.deletedAt)))
      .groupBy(questionTags.tag),
  ]);
  const counts = new Map(used.map((r) => [r.tag, r.n]));
  const out = new Map<string, PoolTag>();
  for (const row of described) {
    out.set(row.tag, { tag: row.tag, description: row.description, count: counts.get(row.tag) ?? 0 });
  }
  for (const row of used) {
    if (!out.has(row.tag)) out.set(row.tag, { tag: row.tag, description: "", count: row.n });
  }
  return [...out.values()].sort((a, b) => a.tag.localeCompare(b.tag));
}

/**
 * Writes the one-line description of a tag. The row is created if the tag is
 * only worn by questions so far, so documenting a tag never needs a separate
 * "create the tag" call.
 */
export async function describeTag(
  db: Db,
  poolId: string,
  tag: string,
  description: string,
): Promise<PoolTag> {
  const name = normalizeTag(tag);
  await db
    .insert(poolTagsTable)
    .values({ poolId, tag: name, description })
    .onConflictDoUpdate({
      target: [poolTagsTable.poolId, poolTagsTable.tag],
      set: { description },
    });
  const [counted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(questionTags)
    .innerJoin(questions, eq(questionTags.questionId, questions.id))
    .where(
      and(eq(questions.poolId, poolId), isNull(questions.deletedAt), eq(questionTags.tag, name)),
    );
  return { tag: name, description, count: counted?.n ?? 0 };
}

/** The one spelling a tag is stored under, everywhere. */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, "").toLowerCase();
}

/**
 * Lazily gives every tag of a pool its `pool_tags` row. Called from the two
 * places that write `question_tags`, so a tag invented in the editor is part
 * of the vocabulary — undocumented, but suggestible and countable — the
 * moment it is saved.
 */
export async function ensurePoolTags(tx: Tx, poolId: string, tags: readonly string[]): Promise<void> {
  if (tags.length === 0) return;
  await tx
    .insert(poolTagsTable)
    .values(tags.map((tag) => ({ poolId, tag })))
    .onConflictDoNothing();
}
