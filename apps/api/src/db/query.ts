import type { PgSelect } from "drizzle-orm/pg-core";

/**
 * The first row of a select, or null: `query.limit(1)`, the row type kept.
 * The query keeps its own WHERE and ORDER BY; only the LIMIT is added here.
 */
export async function first<Q extends { $dynamic(): PgSelect }>(
  query: Q,
): Promise<Awaited<ReturnType<Q["$dynamic"]>>[number] | null> {
  const [row] = await query.$dynamic().limit(1);
  return row ?? null;
}
