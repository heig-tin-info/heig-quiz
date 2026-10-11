/**
 * Find-or-create of a pool's content by its stable names: what an installer
 * keys its idempotence on — the demo seed (`seed/demo.ts`) and the training
 * content (ADR-105 §2, `modules/training`). Every write goes through this
 * module's own services, never a raw insert, so a row made here is a row the
 * application would have written.
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { categories, questions } from "../../db/schema.js";
import { createCategory } from "./categories.js";
import { createQuestion, patchQuestion, publishQuestion, putDraft, type QuestionWriter } from "./questionWrite.js";
import type { QuestionRecord } from "./shared.js";

/** A pool's live question of that `internalName` — case-insensitively, the unique index's rule; a deleted one is none. */
export async function questionByName(db: Db, poolId: string, internalName: string): Promise<QuestionRecord | null> {
  const [row] = await db
    .select()
    .from(questions)
    .where(
      and(
        eq(questions.poolId, poolId),
        isNull(questions.deletedAt),
        sql`lower(${questions.internalName}) = lower(${internalName})`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The root category of that name, created at the end when the pool lacks it. */
export async function ensureCategory(db: Db, poolId: string, name: string): Promise<{ id: string; created: boolean }> {
  const [row] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.poolId, poolId), eq(categories.name, name)))
    .limit(1);
  if (row) return { id: row.id, created: false };
  return { id: (await createCategory(db, poolId, { name })).id, created: true };
}

/** What {@link createPublished} needs of a question: the seed's and the training content's common ground. */
export interface PublishedQuestionSpec {
  type: string;
  internalName: string;
  categoryId: string | null;
  difficulty: number;
  /** Concept labels in the writer's language, resolved as a teacher's input (ADR-081); none by default. */
  concepts?: readonly string[] | undefined;
  config: unknown;
  explanation: string;
  changeNote?: string | undefined;
}

/**
 * One question, from nothing to its first published version, as the writer:
 * created, its header patched, its draft put, published. Throws
 * `DraftInvalid` when the type's schema refuses the config — which is exactly
 * the feedback the author of the content needs.
 */
export async function createPublished(db: Db, poolId: string, spec: PublishedQuestionSpec, writer: QuestionWriter): Promise<QuestionRecord> {
  const row = await createQuestion(db, {
    poolId,
    type: spec.type,
    internalName: spec.internalName,
    categoryId: spec.categoryId,
    createdBy: writer.userId,
  });
  await patchQuestion(db, row, { difficulty: spec.difficulty, concepts: spec.concepts }, writer);
  await putDraft(db, row, { config: spec.config, explanation: spec.explanation });
  await publishQuestion(db, row, { userId: writer.userId, ...(spec.changeNote === undefined ? {} : { changeNote: spec.changeNote }) });
  return row;
}
