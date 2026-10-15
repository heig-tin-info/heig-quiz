/**
 * The concepts a course declares (ADR-081 §8, sixth addendum): a plain set in
 * `course_concepts`, owned by this module like `question_concepts`; the `org`
 * module calls these and reads the links by join. Staff only: nothing here
 * reaches a student payload (invariants 4 and 6).
 *
 * A write share-locks every concept it names or links, in id order, then
 * reads the links again (`lockLinkSet`): a merge in flight finishes first, one
 * that starts after sees the write's locks, and the set the write diffs
 * against is the one under the locks. Two writes racing on one course
 * serialize on the rows: the later insert finds the link already there
 * (`on conflict do nothing`) and the last to commit wins. A `proposed`
 * concept may be listed; a merged or unknown one is a 422
 * `concept_not_found`.
 */
import { and, eq, inArray } from "drizzle-orm";

import { coverageOf } from "@quiz/domain";

import type { ConceptLang, ConceptRef } from "@quiz/contracts";

import { audit, type AuditActor } from "../../audit.js";
import type { Db, Tx } from "../../db/client.js";
import { concepts, courseConcepts } from "../../db/schema.js";
import { byLabel, lockLinkSet } from "./links.js";
import { loadEdges, toConceptRef } from "./row.js";

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
 * COVERAGE, in one place: for each of the given concepts, the concepts it
 * covers, itself first and then every narrower one, near or far (ADR-081 §4:
 * a selected concept covers its narrower ones; sixth addendum, step 7d). The
 * rule is `coverageOf` of `@quiz/domain`, which the pool's concept map
 * applies too (`poolMap.ts`, ADR-116); this is its loader. Only `broader`
 * edges widen it: a `related` concept is never covered, a merged concept has
 * no edges left. One read of the broader edges, whatever the number of ids.
 * Every reader of coverage (the pool and MCP concept filters, a course's
 * filter, the picker's ranking, the teacher's mastery per course concept,
 * the student's) goes through it.
 */
export async function coverage(db: Db | Tx, conceptIds: readonly string[]): Promise<Map<string, string[]>> {
  if (conceptIds.length === 0) return new Map();
  return coverageOf((await loadEdges(db)).broader, conceptIds);
}

/** The union of {@link coverage}: every concept id the given ones cover together. */
export async function coveredConcepts(db: Db | Tx, conceptIds: readonly string[]): Promise<string[]> {
  return [...new Set([...(await coverage(db, conceptIds)).values()].flat())];
}

/**
 * The concept ids the given courses COVER together: what a filter by a
 * course matches and what the picker ranks first (#599 step 7b), the union of
 * {@link coverage} over the courses' own lists.
 */
export async function conceptsCoveredByCourse(db: Db | Tx, courseIds: readonly string[]): Promise<string[]> {
  if (courseIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ id: courseConcepts.conceptId })
    .from(courseConcepts)
    .where(inArray(courseConcepts.courseId, [...courseIds]));
  return coveredConcepts(
    db,
    rows.map((r) => r.id),
  );
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
    const current = await lockLinkSet(tx, ids, async () =>
      (await tx.select({ id: courseConcepts.conceptId }).from(courseConcepts).where(eq(courseConcepts.courseId, courseId))).map(
        (r) => r.id,
      ),
    );
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
        .values(added.map((conceptId) => ({ courseId, conceptId, addedBy: ctx.userId, addedAt: ctx.now })))
        // Two owners saving at once: the second finds the link the first wrote.
        .onConflictDoNothing();
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
