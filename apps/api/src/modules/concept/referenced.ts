import { eq, sql, type SQL } from "drizzle-orm";
import { alias, type PgColumn } from "drizzle-orm/pg-core";

import { concepts, courseConcepts, questionConcepts } from "../../db/schema.js";

/**
 * Whether anything refers to the concept `id`: a question link (deleted
 * questions keep theirs), a course that lists it or a concept merged into it.
 * It mirrors the three foreign keys `deleteConcept` maps to 409 `concept_in_use`
 * (`question_concepts.concept_id`, `course_concepts.concept_id`, `concepts.merged_into`), so the queue's
 * `deletable` and the deletion agree; a new reference to `concepts` is added
 * here and there.
 */
export function conceptReferenced(id: PgColumn): SQL<boolean> {
  // Drizzle renders an aliased table without its source: `alias(concepts, "merged")` and the raw `as "merged"` below must match.
  const merged = alias(concepts, "merged");
  return sql<boolean>`(exists (select 1 from ${questionConcepts} where ${eq(questionConcepts.conceptId, id)})
    or exists (select 1 from ${courseConcepts} where ${eq(courseConcepts.conceptId, id)})
    or exists (select 1 from ${concepts} as "merged" where ${eq(merged.mergedInto, id)}))`;
}
