/**
 * The relations the curation screen proposes without a model (#897 step A1,
 * ADR-114): broader candidates by label containment and related candidates by
 * co-occurrence on live questions. The rules are `@quiz/domain`'s
 * (`relationCandidatesOf`); this file loads the vocabulary, the edges and the
 * pair counts. Nothing is stored and
 * nothing is written: the admin accepts each edge through the relation routes.
 *
 * The co-occurrence counts are instance-wide and numbers only: no question id,
 * statement, pool or person leaves, the exception ADR-054 (amended) grants
 * the queue's `questionCount`.
 */
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { ConceptRelationCandidates } from "@quiz/contracts";
import { RELATION_CANDIDATE_LIMITS, relationCandidatesOf } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { concepts, questionConcepts, questions } from "../../db/schema.js";
import { loadEdges, toResolvable } from "./row.js";

/** How many co-occurring pairs, most shared first, the scan reads before the share and the rules filter them. */
const PAIR_SCAN = 500;

const liveQuestion = and(eq(questions.id, questionConcepts.questionId), isNull(questions.deletedAt));

export async function relationCandidates(db: Db): Promise<ConceptRelationCandidates> {
  const rows = await db.select().from(concepts).where(ne(concepts.status, "merged"));
  const live = new Set(rows.map((r) => r.id));
  const qc2 = alias(questionConcepts, "qc2");
  const pairs = (
    await db
      .select({ a: questionConcepts.conceptId, b: qc2.conceptId, shared: count() })
      .from(questionConcepts)
      .innerJoin(qc2, and(eq(qc2.questionId, questionConcepts.questionId), lt(questionConcepts.conceptId, qc2.conceptId)))
      .innerJoin(questions, liveQuestion)
      .groupBy(questionConcepts.conceptId, qc2.conceptId)
      .having(gte(count(), RELATION_CANDIDATE_LIMITS.min))
      .orderBy(desc(count()), asc(questionConcepts.conceptId), asc(qc2.conceptId))
      .limit(PAIR_SCAN)
  ).filter((p) => live.has(p.a) && live.has(p.b));
  const used = new Map<string, number>();
  const ids = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  if (ids.length > 0) {
    const counts = await db
      .select({ id: questionConcepts.conceptId, n: count() })
      .from(questionConcepts)
      .innerJoin(questions, liveQuestion)
      .where(inArray(questionConcepts.conceptId, ids))
      .groupBy(questionConcepts.conceptId);
    for (const c of counts) used.set(c.id, c.n);
  }
  const candidates = relationCandidatesOf(
    rows.map((r) => toResolvable(r, new Map())),
    await loadEdges(db),
    pairs.map((p) => ({ ...p, smaller: Math.min(used.get(p.a)!, used.get(p.b)!) })),
  );
  return { candidates };
}
