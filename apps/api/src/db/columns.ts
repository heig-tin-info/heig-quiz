/**
 * Column types and constraint helpers shared by the schemas of several modules. Not a table file:
 * `db/schema.ts` does not re-export it.
 */
import { type SQL, sql } from "drizzle-orm";
import { type AnyPgColumn, customType } from "drizzle-orm/pg-core";

import type { Values } from "@quiz/domain/parameters";

/**
 * The body of a `CHECK` that holds a text column to a closed list: the SAME
 * constant its `{ enum: ... }` reads, so a value added to the list in
 * TypeScript only reaches the database with a migration that widens the
 * check (`drizzle-kit generate` sees the expression change). The values are
 * inlined as quoted literals: a DDL statement has no bind parameters, and a
 * quote inside a value is doubled. A NULL passes, as `IN` yields unknown on
 * it: a nullable column keeps its NULL.
 */
export function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  const literals = values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
  return sql`${column} in (${sql.raw(literals)})`;
}

/**
 * The values one instance of a parameterized question was drawn with
 * (ADR-056 §5): `attempts.instances` per item, `drill_cards.serve_values`,
 * `drill_reviews.values`. `versionId` is the version they were DRAWN for:
 * read under another one (a regrade, a republished drill question) they are
 * replayed (`replay` of `@quiz/domain/parameters`), never redrawn.
 * `fallback` marks a draw that did not go to plan — the condition never
 * held in 100 runs, or the drawn values failed — and was served anyway
 * (ADR-056 §7): the grading details say so, the student never does.
 */
export interface StoredInstance {
  versionId: string;
  values: Values;
  fallback?: "exhausted" | "failed";
}

/** A `bytea` column, read and written as a Buffer (avatars, journal assets). */
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});
