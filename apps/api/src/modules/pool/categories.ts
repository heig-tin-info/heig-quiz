/** The category tree of a pool. */
import { randomUUID } from "node:crypto";

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { Category, CategoryCountNode, CategoryNode, PoolCategories } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { categories, questions } from "../../db/schema.js";

function categoryJson(row: typeof categories.$inferSelect): Category {
  return {
    id: row.id,
    poolId: row.poolId,
    parentId: row.parentId,
    name: row.name,
    position: row.position,
  };
}

/** The folders of a pool as a tree; siblings ordered by `position` then name. */
export async function categoryTree(db: Db, poolId: string): Promise<CategoryNode[]> {
  const rows = await db
    .select()
    .from(categories)
    .where(eq(categories.poolId, poolId))
    .orderBy(asc(categories.position), asc(categories.name));
  const nodes = new Map<string, CategoryNode>(
    rows.map((r) => [r.id, { ...categoryJson(r), children: [] }]),
  );
  const roots: CategoryNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parentId ? nodes.get(row.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * `GET /pools/:id/categories`: the tree of the categories page, each folder
 * with the live questions filed directly in it, and the root's own count.
 * One grouped count, not one per folder.
 */
export async function categoriesWithCounts(db: Db, poolId: string): Promise<PoolCategories> {
  const [tree, counted] = await Promise.all([
    categoryTree(db, poolId),
    db
      .select({ categoryId: questions.categoryId, n: sql<number>`count(*)::int` })
      .from(questions)
      .where(and(eq(questions.poolId, poolId), isNull(questions.deletedAt)))
      .groupBy(questions.categoryId),
  ]);
  const counts = new Map(counted.map((r) => [r.categoryId, r.n]));
  const withCounts = (nodes: CategoryNode[]): CategoryCountNode[] =>
    nodes.map((node) => ({
      ...node,
      questionCount: counts.get(node.id) ?? 0,
      children: withCounts(node.children),
    }));
  return { categories: withCounts(tree), rootQuestionCount: counts.get(null) ?? 0 };
}

export async function createCategory(
  db: Db,
  poolId: string,
  input: { name: string; parentId?: string | null | undefined },
): Promise<Category> {
  const parentId = input.parentId ?? null;
  const [last] = await db
    .select({ max: sql<number>`coalesce(max(${categories.position}), -1)::int` })
    .from(categories)
    .where(
      and(
        eq(categories.poolId, poolId),
        parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId),
      ),
    );
  const [row] = await db
    .insert(categories)
    .values({
      id: randomUUID(),
      poolId,
      parentId,
      name: input.name,
      position: (last?.max ?? -1) + 1,
    })
    .returning();
  return categoryJson(row!);
}

/**
 * A folder cannot become its own descendant; the walk up the parent chain is
 * what keeps the tree a tree (the database only knows the edge is valid).
 */
export async function wouldCycle(
  db: Db,
  categoryId: string,
  newParentId: string | null,
): Promise<boolean> {
  let cursor = newParentId;
  for (let hops = 0; cursor !== null && hops < 64; hops += 1) {
    if (cursor === categoryId) return true;
    const [row] = await db
      .select({ parentId: categories.parentId })
      .from(categories)
      .where(eq(categories.id, cursor))
      .limit(1);
    if (!row) return false;
    cursor = row.parentId;
  }
  return false;
}

export async function updateCategory(
  db: Db,
  categoryId: string,
  patch: {
    name?: string | undefined;
    parentId?: string | null | undefined;
    position?: number | undefined;
  },
): Promise<Category> {
  const [row] = await db
    .update(categories)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
    })
    .where(eq(categories.id, categoryId))
    .returning();
  return categoryJson(row!);
}

/**
 * Is this new layout of the tree a tree of THIS pool? Every folder moved and
 * every parent named must belong to the pool (a crafted payload must not hang
 * a folder under another pool's), and the layout the payload produces —
 * the moves applied TOGETHER, not one by one against the old tree — must
 * have no cycle: "A under B" and "B under A" are each fine alone.
 */
export async function checkCategoryLayout(
  db: Db,
  poolId: string,
  items: readonly { id: string; parentId: string | null }[],
): Promise<"not_found" | "cycle" | null> {
  const rows = await db
    .select({ id: categories.id, parentId: categories.parentId })
    .from(categories)
    .where(eq(categories.poolId, poolId));
  const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));
  for (const item of items) {
    if (!parentOf.has(item.id)) return "not_found";
    if (item.parentId !== null && !parentOf.has(item.parentId)) return "not_found";
  }
  for (const item of items) parentOf.set(item.id, item.parentId);
  for (const item of items) {
    let cursor = parentOf.get(item.id) ?? null;
    for (let hops = 0; cursor !== null; hops += 1) {
      if (cursor === item.id || hops > parentOf.size) return "cycle";
      cursor = parentOf.get(cursor) ?? null;
    }
  }
  return null;
}

/**
 * Drag-and-drop reorder of the whole tree in one call. Only the rows of this
 * pool are touched, so a crafted payload cannot move a folder into another
 * pool's tree.
 */
export async function reorderCategories(
  db: Db,
  poolId: string,
  items: readonly { id: string; parentId: string | null; position: number }[],
): Promise<CategoryNode[]> {
  await db.transaction(async (tx) => {
    for (const item of items) {
      await tx
        .update(categories)
        .set({ parentId: item.parentId, position: item.position })
        .where(and(eq(categories.id, item.id), eq(categories.poolId, poolId)));
    }
  });
  return categoryTree(db, poolId);
}

/** Deleting a folder deletes its subtree; its questions fall back to the root. */
export async function deleteCategory(db: Db, categoryId: string): Promise<void> {
  await db.delete(categories).where(eq(categories.id, categoryId));
}
