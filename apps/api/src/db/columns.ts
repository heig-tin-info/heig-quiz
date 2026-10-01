/**
 * Column types shared by the schemas of several modules. Not a table file:
 * `db/schema.ts` does not re-export it.
 */
import { customType } from "drizzle-orm/pg-core";

import type { Values } from "@quiz/domain/parameters";

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
