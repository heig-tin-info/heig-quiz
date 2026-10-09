/**
 * What the files of the `pool` service share: the row types, the errors a
 * question write can raise, the category guard and `qualified`.
 */
import { and, eq } from "drizzle-orm";

import type { ZodIssueLite } from "@quiz/contracts";

import { isForeignKeyViolation, isUniqueViolation, type Db, type Tx } from "../../db/client.js";
import { DomainError } from "../http.js";
import { categories, pools, questionVersions, questions } from "../../db/schema.js";

export type { Tx };

export type PoolRow = typeof pools.$inferSelect;
export type QuestionRecord = typeof questions.$inferSelect;

/**
 * The pool of a question this module was handed. Every route reaches a
 * question THROUGH its pool (`findAccessibleQuestion` joins `pools`), and the
 * only questions without one — the unsaved questions of a poll (ADR-014,
 * addendum 2026-09-23) — are never reached that way; a null here is a bug.
 */
export function poolOf(question: QuestionRecord): string {
  if (question.poolId === null) throw new Error(`question ${question.id} belongs to no pool`);
  return question.poolId;
}
export type VersionRecord = typeof questionVersions.$inferSelect;

/** A draft cannot be published while its config does not satisfy the schema (D16). */
export class DraftInvalid extends Error {
  constructor(readonly issues: ZodIssueLite[]) {
    super("draft config is invalid");
    this.name = "DraftInvalid";
  }
}

/** The question has no draft row at all — a corrupted question, never normal. */
export class MissingDraft extends Error {
  constructor() {
    super("question has no draft");
    this.name = "MissingDraft";
  }
}

/** A published version is referenced by an evaluation item (`409 in_use`). */
export class VersionInUse extends Error {
  constructor() {
    super("a published version is in use");
    this.name = "VersionInUse";
  }
}

/**
 * A category that is not a category OF THE QUESTION'S POOL — another pool's,
 * or one that does not exist: as good as missing, the `404 not_found` a move
 * answers. The pool routes send it as `{ error: "not_found" }`.
 */
export class CategoryNotInPool extends DomainError {
  override name = "CategoryNotInPool";
  constructor() {
    super("not_found", 404, "the category is not a category of this pool");
  }
}

/** True when `categoryId` is null or a category of `poolId`. */
export async function isCategoryOf(
  db: Db | Tx,
  poolId: string,
  categoryId: string | null,
): Promise<boolean> {
  if (categoryId === null) return true;
  const [category] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.poolId, poolId)))
    .limit(1);
  return category !== undefined;
}

export async function assertCategoryOf(
  db: Db | Tx,
  poolId: string,
  categoryId: string | null | undefined,
): Promise<void> {
  if (!(await isCategoryOf(db, poolId, categoryId ?? null))) throw new CategoryNotInPool();
}

/**
 * A write of `questions` refused by a constraint a caller can trip: its
 * name taken in the pool, or — the backstop of `assertCategoryOf` — a
 * category deleted in between. Anything else is rethrown as it is.
 */
export function questionWriteError(error: unknown): unknown {
  if (isUniqueViolation(error, "questions_pool_name_uq")) {
    return new DomainError("duplicate_name", 409, "This pool already has a question by that name");
  }
  if (isForeignKeyViolation(error, "questions_category_id_categories_id_fk")) {
    return new CategoryNotInPool();
  }
  return error;
}
