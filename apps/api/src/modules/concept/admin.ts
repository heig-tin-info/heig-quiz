/**
 * The admin's curation queue (ADR-081, fifth addendum): the concepts that are
 * not merged, `proposed` first, with how many questions use each. The
 * vocabulary is small and loaded whole, like `listConcepts`; filtering and
 * searching are the client's.
 *
 * The count is instance-wide and a number only: an admin without Super Powers
 * reads it, though the questions sit in pools they cannot reach, because
 * deleting or merging a concept is a decision about all of them (ADR-054
 * amended). The route names no pool and no statement. Only live questions are
 * counted; `deletable` is the separate answer to `DELETE`, which a deleted
 * question's surviving link also refuses.
 */
import { asc, count, eq, ne, sql } from "drizzle-orm";

import type { AdminConcept } from "@quiz/contracts";
import { displayName } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { concepts, questionConcepts, questions, users } from "../../db/schema.js";
import { conceptReferenced } from "./referenced.js";
import { loadAliases, toConcept } from "./row.js";

export async function listAdminConcepts(db: Db): Promise<AdminConcept[]> {
  const live = db
    .select({ conceptId: questionConcepts.conceptId, n: count().as("n") })
    .from(questionConcepts)
    .innerJoin(questions, eq(questions.id, questionConcepts.questionId))
    .where(sql`${questions.deletedAt} is null`)
    .groupBy(questionConcepts.conceptId)
    .as("live");

  const rows = await db
    .select({
      concept: concepts,
      used: sql<number>`coalesce(${live.n}, 0)`.mapWith(Number),
      referenced: conceptReferenced(concepts.id),
      givenName: users.givenName,
      familyName: users.familyName,
    })
    .from(concepts)
    .leftJoin(live, eq(live.conceptId, concepts.id))
    .leftJoin(users, eq(users.id, concepts.createdBy))
    .where(ne(concepts.status, "merged"))
    .orderBy(
      sql`case ${concepts.status} when 'proposed' then 0 else 1 end`,
      asc(sql`lower(coalesce(${concepts.labelFr}, ${concepts.labelEn}))`),
      asc(concepts.id),
    );

  const aliases = await loadAliases(db);
  return rows.map(
    (r): AdminConcept => ({
      ...toConcept(r.concept, aliases.get(r.concept.id)),
      questionCount: r.used,
      deletable: !r.referenced,
      creator: displayName({ givenName: r.givenName, familyName: r.familyName, email: null }) || null,
    }),
  );
}
