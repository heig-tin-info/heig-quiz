/**
 * The concepts a course declares (ADR-081 §8, sixth addendum): a plain set in
 * `course_concepts`, owned by this module like `question_concepts`; the `org`
 * module calls these and reads the links by join. Staff only: nothing here
 * reaches a student payload (invariants 4 and 6).
 *
 * A write share-locks every concept it names or drops, in id order
 * (`lockConcepts`), so a merge in flight finishes before the write reads the
 * links and one that starts after it sees the loser merged: the link a merge
 * rewrites is never re-created on the loser. A `proposed` concept may be
 * listed; a merged or unknown one is a 422 `concept_not_found`.
 */
import { and, eq, inArray } from "drizzle-orm";

import type { ConceptLang, ConceptRef } from "@quiz/contracts";

import { audit, type AuditActor } from "../../audit.js";
import type { Db, Tx } from "../../db/client.js";
import { concepts, courseConcepts } from "../../db/schema.js";
import { DomainError } from "../http.js";
import { byLabel, lockConcepts } from "./links.js";
import { toConceptRef } from "./row.js";

/** The concepts of a course, labelled in `lang`, by label then id. */
export async function courseConceptsOf(db: Db | Tx, courseId: string, lang: ConceptLang): Promise<ConceptRef[]> {
  const rows = await db
    .select({ concept: concepts })
    .from(courseConcepts)
    .innerJoin(concepts, eq(concepts.id, courseConcepts.conceptId))
    .where(eq(courseConcepts.courseId, courseId));
  return rows.map((r) => toConceptRef(r.concept, lang)).sort(byLabel);
}

/**
 * Replaces the course's concepts with `conceptIds` (duplicates ignored), in
 * one audited transaction (`course.concepts_update`, the ids added and
 * removed). A link already there keeps its author and date; a call that
 * changes nothing writes and audits nothing.
 */
export async function setCourseConcepts(
  db: Db,
  ctx: { actor: AuditActor; userId: string; now: Date },
  courseId: string,
  conceptIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(conceptIds)];
  await db.transaction(async (tx) => {
    const current = (
      await tx.select({ id: courseConcepts.conceptId }).from(courseConcepts).where(eq(courseConcepts.courseId, courseId))
    ).map((r) => r.id);
    const live = await lockConcepts(tx, [...new Set([...ids, ...current])]);
    const bad = ids.filter((id) => !live.has(id));
    if (bad.length > 0) {
      throw new DomainError("concept_not_found", 422, "A concept is missing or merged", { ids: bad }); // `ConceptNotFound`
    }
    const wanted = new Set(ids);
    const present = new Set(current);
    const removed = current.filter((id) => !wanted.has(id)).sort();
    const added = ids.filter((id) => !present.has(id)).sort();
    if (removed.length > 0) {
      await tx
        .delete(courseConcepts)
        .where(and(eq(courseConcepts.courseId, courseId), inArray(courseConcepts.conceptId, removed)));
    }
    if (added.length > 0) {
      await tx
        .insert(courseConcepts)
        .values(added.map((conceptId) => ({ courseId, conceptId, addedBy: ctx.userId, addedAt: ctx.now })));
    }
    if (added.length === 0 && removed.length === 0) return;
    await audit(tx, {
      ...ctx.actor,
      action: "course.concepts_update",
      subjectType: "course",
      subjectId: courseId,
      payload: { added, removed },
    });
  });
}
