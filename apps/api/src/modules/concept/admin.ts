/**
 * The admin's curation queue (ADR-081, fifth addendum): the concepts that are
 * not merged, `proposed` first, with how many questions use each.
 *
 * The count is instance-wide and a number only: an admin without Super Powers
 * reads it, though the questions sit in pools they cannot reach, because
 * deleting or merging a concept is a decision about all of them (ADR-054
 * amended). The route names no pool and no statement. Only live questions are
 * counted; `deletable` is the separate answer to `DELETE`, which a deleted
 * question's surviving link also refuses.
 */
import { and, asc, count, eq, ilike, ne, or, sql, type SQL } from "drizzle-orm";

import type { AdminConcept, AdminConceptList, AdminConceptQuery } from "@quiz/contracts";
import { conceptKey } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { concepts, questionConcepts, questions, users } from "../../db/schema.js";
import { toConcept } from "./row.js";

/** `%` and `_` typed by the admin are letters to find, not wildcards. */
const likeOf = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

/** Whether `q` occurs in a label, or in a key (accents and plurals folded) of either language. */
function matching(q: string): SQL | undefined {
  const key = conceptKey(q);
  return or(
    ilike(concepts.labelFr, likeOf(q)),
    ilike(concepts.labelEn, likeOf(q)),
    key === "" ? undefined : ilike(concepts.keyFr, likeOf(key)),
    key === "" ? undefined : ilike(concepts.keyEn, likeOf(key)),
  );
}

export async function listAdminConcepts(db: Db, query: AdminConceptQuery): Promise<AdminConceptList> {
  const where = and(
    ne(concepts.status, "merged"),
    query.status ? eq(concepts.status, query.status) : undefined,
    query.q ? matching(query.q) : undefined,
  );
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
      deletable: sql<boolean>`not exists (select 1 from question_concepts qc where qc.concept_id = ${concepts.id})
        and not exists (select 1 from concepts m where m.merged_into = ${concepts.id})`,
      givenName: users.givenName,
      familyName: users.familyName,
    })
    .from(concepts)
    .leftJoin(live, eq(live.conceptId, concepts.id))
    .leftJoin(users, eq(users.id, concepts.createdBy))
    .where(where)
    .orderBy(
      sql`case ${concepts.status} when 'proposed' then 0 else 1 end`,
      asc(sql`lower(coalesce(${concepts.labelFr}, ${concepts.labelEn}))`),
      asc(concepts.id),
    )
    .limit(query.limit)
    .offset(query.offset);

  const [matched] = await db.select({ total: count() }).from(concepts).where(where);
  const [waiting] = await db.select({ proposed: count() }).from(concepts).where(eq(concepts.status, "proposed"));

  return {
    concepts: rows.map(
      (r): AdminConcept => ({
        ...toConcept(r.concept),
        questionCount: r.used,
        deletable: r.deletable,
        creator: r.givenName === null ? null : `${r.givenName} ${r.familyName}`.trim() || null,
      }),
    ),
    total: matched?.total ?? 0,
    proposed: waiting?.proposed ?? 0,
  };
}
