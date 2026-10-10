/**
 * The public pool catalogue (ADR-095): the `is_public` pools, searched over
 * their name, description, inferred domain and the concept labels (both
 * languages) of their published, non-deleted questions, ranked by how many
 * teachers follow them.
 *
 * The match is a normalised `ILIKE`, never an extension (`pg_trgm` is absent
 * from PGlite): the query's words come from `catalogueTerms` (ADR-081's
 * `similarityTerms` plus the accent folding), each of them must be found in
 * at least one of the fields, and the stored text is folded in SQL with
 * `translate` the same way the term is folded in TypeScript.
 */
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";

import type { CatalogueQuery, PoolSummary } from "@quiz/contracts";
import { catalogueTerms, FOLD_LIGATURES, foldText, type CatalogueTerm } from "@quiz/domain";

import { qualified, type Db } from "../../db/client.js";
import { concepts, pools, questionConcepts, questions } from "../../db/schema.js";
import { poolAccess, type Caller } from "../guards.js";
import { livePublishedQuestion } from "./domain.js";
import { listPools, memberCountOf, subscriberCountOf, usedCount } from "./pools.js";

/**
 * The accented letters the SQL fold maps, DERIVED from `foldText` so the two
 * cannot disagree: the candidates that fold to exactly one other letter
 * (Western and Central European), in both cases. A letter NFKD leaves whole
 * (ø, ł, đ) stays itself in both folds.
 */
const CANDIDATES = [..."àáâãäåāăąçćĉċčďèéêëēĕėęěĝğġģĥìíîïĩīĭįĵķĺļľñńņňòóôõöōŏőŕŗřśŝşšţťùúûüũūŭůűųŵýÿŷźżž"];
export const ACCENTED = CANDIDATES.filter((c) => foldText(c).length === 1 && foldText(c) !== c);
export const PLAIN = ACCENTED.map(foldText);
/** The upper-case forms of the ligatures: the SQL text is folded before `lower()` (locale-proof). */
const UPPER_LIGATURES = FOLD_LIGATURES.map(([from, to]) => [from.toUpperCase(), to] as const).filter(([from]) => from.length === 1);

/** The column as text compared lower-case and without accents (the SQL twin of `foldText`). */
const folded = (column: SQL | ReturnType<typeof qualified>) => {
  const spelled = [...FOLD_LIGATURES, ...UPPER_LIGATURES].reduce<SQL>(
    (text, [from, to]) => sql`replace(${text}, ${from}, ${to})`,
    sql`coalesce(${column}, '')`,
  );
  const from = ACCENTED.join("") + ACCENTED.join("").toUpperCase();
  return sql`lower(translate(${spelled}, ${from}, ${PLAIN.join("") + PLAIN.join("")}))`;
};

const likeOf = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** A published, non-deleted question of the pool has a concept that matches the term. */
function conceptMatches(term: CatalogueTerm): SQL {
  const pattern = likeOf(term.folded);
  const byKey = term.key === "" ? sql`false` : sql`(${qualified(concepts.keyFr)} ILIKE ${likeOf(term.key)} OR ${qualified(concepts.keyEn)} ILIKE ${likeOf(term.key)})`;
  return sql`EXISTS (SELECT 1 FROM ${questionConcepts}
    JOIN ${concepts} ON ${qualified(concepts.id)} = ${qualified(questionConcepts.conceptId)}
    JOIN ${questions} ON ${qualified(questions.id)} = ${qualified(questionConcepts.questionId)}
    WHERE ${qualified(questions.poolId)} = ${qualified(pools.id)}
      AND ${livePublishedQuestion}
      AND (${folded(qualified(concepts.labelFr))} ILIKE ${pattern} OR ${folded(qualified(concepts.labelEn))} ILIKE ${pattern} OR ${byKey}))`;
}

/** One term is found somewhere: the pool's own texts, or one of its concepts. */
function termMatches(term: CatalogueTerm): SQL {
  const pattern = likeOf(term.folded);
  return sql`(${folded(qualified(pools.name))} ILIKE ${pattern}
    OR ${folded(qualified(pools.description))} ILIKE ${pattern}
    OR ${folded(qualified(pools.domainFr))} ILIKE ${pattern}
    OR ${folded(qualified(pools.domainEn))} ILIKE ${pattern}
    OR ${conceptMatches(term)})`;
}

/**
 * The catalogue for `viewer`: public pools only — whatever Super Powers, which
 * widen nobody's catalogue —, each with the usual summary (the viewer's role,
 * the counters, whether they subscribed). The most followed first (subscribers
 * plus members), then the most used (`usedCount`), then by name.
 */
export async function catalogue(db: Db, viewer: Caller, query: CatalogueQuery): Promise<PoolSummary[]> {
  const terms = catalogueTerms(query.q);
  const where = and(poolAccess(viewer.id), eq(pools.isPublic, true), ...terms.map(termMatches));
  return listPools(db, where, viewer, {
    orderBy: [desc(sql`${subscriberCountOf} + ${memberCountOf}`), desc(usedCount), asc(pools.name)],
    limit: query.limit,
  });
}
