/**
 * The sorting of the existing tags (ADR-081, second addendum 2026-10-08):
 * every (pool, tag) pair with what the admin needs to decide it, and the
 * admin's accept, which writes the decisions and creates the new concepts
 * they name, validated, in one transaction.
 *
 * It reads `question_tags`, `pool_tags`, `questions` and their versions by
 * join and never writes them. A pair's excerpts come from the student view
 * of the latest published version (`questionExcerpt`): never an answer key,
 * the internal name or the search text (second addendum §3). The admin
 * role is enough (§4): the routes are the admin's, without Super Powers.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";

import {
  CONCEPT_LANGS,
  type Concept,
  type TagPair,
  type TagSorting,
  type TagSortingAcceptResponse,
  type TagSortingItem,
  type TagSortingRow,
} from "@quiz/contracts";
import { groupNewConcepts, groupTagsByConceptKey, tagGroupKey, type NewConceptGroup } from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import { isUniqueViolation, type Db } from "../../db/client.js";
import {
  conceptTagSortings,
  concepts,
  pools,
  poolTags,
  questions,
  questionTags,
  questionVersions,
} from "../../db/schema.js";
import { DomainError } from "../http.js";
import { questionExcerpt } from "../../questionText.js";
import { COLUMNS, columnsOf, holdersOf, perLang, toConcept, type ConceptRow } from "./row.js";

/** Who accepts: the admin, for `decided_by` and the audit; the server's instant. */
export interface SortingContext {
  userId: string;
  actor: AuditActor;
  now: Date;
}

/** Statements shown per pair, and their length: enough to recognise a question (§3). */
const EXCERPTS = 2;
const EXCERPT_CHARS = 300;
/**
 * Questions read per pair for its excerpts: a few more than shown, since a
 * version whose config no longer loads gives none and the next one is taken.
 */
const CANDIDATES = 4;

type SortingRow = typeof conceptTagSortings.$inferSelect;

const pairKey = (pair: TagPair) => JSON.stringify([pair.poolId, pair.tag]);

function toSorting(row: SortingRow, concept: ConceptRow | null): TagSorting {
  return {
    decision: row.decision,
    concept: concept ? toConcept(concept) : null,
    dropReason: row.dropReason,
    proposal: row.proposal,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

/** The questions a pair counts: live, in a pool. */
const liveInPool = and(isNull(questions.deletedAt), isNotNull(questions.poolId));

/**
 * Every pair worn by a live question, by `conceptKey` group, most worn
 * first (`groupTagsByConceptKey`). Three grouped queries, whatever the
 * number of pairs: the counts with the pool and the tag's description; the
 * latest published versions of the oldest questions of each pair, a
 * parameterized one left out (ADR-056: a template is not read as a config);
 * the sorting rows with their concept.
 */
export async function listTagSortings(db: Db): Promise<TagSortingRow[]> {
  const latest = db
    .selectDistinctOn([questionVersions.questionId], {
      questionId: questionVersions.questionId,
      config: questionVersions.config,
      configVersion: questionVersions.configVersion,
      variables: questionVersions.variables,
    })
    .from(questionVersions)
    .where(isNotNull(questionVersions.number))
    .orderBy(questionVersions.questionId, desc(questionVersions.number))
    .as("latest");
  const ranked = db
    .select({
      poolId: questions.poolId,
      tag: questionTags.tag,
      type: questions.type,
      config: latest.config,
      configVersion: latest.configVersion,
      rank: sql<number>`row_number() over (partition by ${questions.poolId}, ${questionTags.tag} order by ${questions.createdAt}, ${questions.id})`.as(
        "rank",
      ),
    })
    .from(questionTags)
    .innerJoin(questions, eq(questions.id, questionTags.questionId))
    .innerJoin(latest, eq(latest.questionId, questions.id))
    .where(and(liveInPool, isNull(latest.variables)))
    .as("ranked");

  const [counted, statements, sorted] = await Promise.all([
    db
      .select({
        poolId: questions.poolId,
        tag: questionTags.tag,
        poolName: pools.name,
        description: sql<string>`coalesce(${poolTags.description}, '')`,
        count: sql<number>`count(*)::int`,
      })
      .from(questionTags)
      .innerJoin(questions, eq(questions.id, questionTags.questionId))
      .innerJoin(pools, eq(pools.id, questions.poolId))
      .leftJoin(poolTags, and(eq(poolTags.poolId, questions.poolId), eq(poolTags.tag, questionTags.tag)))
      .where(liveInPool)
      .groupBy(questions.poolId, questionTags.tag, pools.name, poolTags.description),
    db
      .select({
        poolId: ranked.poolId,
        tag: ranked.tag,
        type: ranked.type,
        config: ranked.config,
        configVersion: ranked.configVersion,
      })
      .from(ranked)
      .where(lte(ranked.rank, CANDIDATES))
      .orderBy(ranked.rank),
    db
      .select({ sorting: conceptTagSortings, concept: concepts })
      .from(conceptTagSortings)
      .leftJoin(concepts, eq(concepts.id, conceptTagSortings.conceptId)),
  ]);

  const excerpts = new Map<string, string[]>();
  for (const s of statements) {
    const key = pairKey({ poolId: s.poolId!, tag: s.tag });
    const kept = excerpts.get(key) ?? [];
    if (kept.length === EXCERPTS) continue;
    const text = questionExcerpt(s.type, { ...s, variables: null }, EXCERPT_CHARS);
    if (text) excerpts.set(key, [...kept, text].slice(0, EXCERPTS));
  }
  const sortings = new Map(sorted.map((r) => [pairKey(r.sorting), toSorting(r.sorting, r.concept)]));
  const rows = counted.map((r) => {
    const pair = { poolId: r.poolId!, tag: r.tag };
    return {
      ...pair,
      poolName: r.poolName,
      count: r.count,
      description: r.description,
      excerpts: excerpts.get(pairKey(pair)) ?? [],
      group: tagGroupKey(r.tag),
      sorting: sortings.get(pairKey(pair)) ?? null,
    };
  });
  return groupTagsByConceptKey(rows).flatMap((g) => g.pairs);
}

const itemsError = (code: "tag_unknown" | "concept_not_found" | "concept_batch_conflict", items: TagPair[]) =>
  new DomainError(code, 422, code, { items: items.map(({ poolId, tag }) => ({ poolId, tag })) });

/**
 * The admin's accept (second addendum §1, §2), in one transaction: every
 * pair must be worn by a live question of its pool (422 `tag_unknown`); an
 * existing concept must be there and not merged (422 `concept_not_found`);
 * a new concept is created `validated` with both labels, once per distinct
 * pair of keys (`groupNewConcepts`; 422 `concept_batch_conflict` for two
 * that share one language's key only). A key already held hits the unique
 * index, as `createConcept` does, and is answered 409 `concept_exists`
 * naming each holder and the items that asked for it. Each pair's row is
 * written with the admin's decision at the server's instant, over a
 * proposal or a former decision; the proposal stays. Audited per pool
 * (`concept.sort`) and per created concept (`concept.validate`).
 */
export async function acceptTagSortings(
  db: Db,
  ctx: SortingContext,
  items: readonly TagSortingItem[],
): Promise<TagSortingAcceptResponse> {
  const grouping = groupNewConcepts(
    items.flatMap((item) => (item.decision.kind === "new" ? [{ item, fr: item.decision.fr, en: item.decision.en }] : [])),
  );
  if (grouping.kind === "clash") throw itemsError("concept_batch_conflict", grouping.items);
  const wanted = grouping.concepts;
  try {
    return await db.transaction(async (tx) => {
      const worn = await tx
        .selectDistinct({ poolId: questions.poolId, tag: questionTags.tag })
        .from(questionTags)
        .innerJoin(questions, eq(questions.id, questionTags.questionId))
        .where(
          and(
            liveInPool,
            inArray(questions.poolId, [...new Set(items.map((i) => i.poolId))]),
            inArray(questionTags.tag, [...new Set(items.map((i) => i.tag))]),
          ),
        );
      const wornKeys = new Set(worn.map((w) => pairKey({ poolId: w.poolId!, tag: w.tag })));
      const unknown = items.filter((i) => !wornKeys.has(pairKey(i)));
      if (unknown.length > 0) throw itemsError("tag_unknown", unknown);

      const targetIds = [
        ...new Set(items.flatMap((i) => (i.decision.kind === "concept" ? [i.decision.conceptId] : []))),
      ];
      const targets =
        targetIds.length === 0
          ? []
          : await tx
              .select()
              .from(concepts)
              .where(and(inArray(concepts.id, targetIds), ne(concepts.status, "merged")));
      const byId = new Map<string, ConceptRow>(targets.map((c) => [c.id, c]));
      const missing = items.filter((i) => i.decision.kind === "concept" && !byId.has(i.decision.conceptId));
      if (missing.length > 0) throw itemsError("concept_not_found", missing);

      const created: ConceptRow[] = [];
      const conceptOf = new Map<string, string>();
      for (const c of wanted) {
        const id = randomUUID();
        const [row] = await tx
          .insert(concepts)
          .values({
            id,
            status: "validated",
            createdBy: ctx.userId,
            ...columnsOf("fr", c.sides.fr),
            ...columnsOf("en", c.sides.en),
            createdAt: ctx.now,
            updatedAt: ctx.now,
          })
          .returning();
        created.push(row!);
        byId.set(id, row!);
        for (const item of c.items) conceptOf.set(pairKey(item), id);
        await audit(tx, {
          ...ctx.actor,
          action: "concept.validate",
          subjectType: "concept",
          subjectId: id,
          payload: {
            created: true,
            labels: perLang((lang) => c.sides[lang].label),
            qualifiers: perLang((lang) => c.sides[lang].qualifier),
          },
        });
      }

      const decided = items.map((item) => {
        const d = item.decision;
        const conceptId =
          d.kind === "concept" ? d.conceptId : d.kind === "new" ? conceptOf.get(pairKey(item))! : null;
        return {
          poolId: item.poolId,
          tag: item.tag,
          decision: d.kind === "drop" ? ("drop" as const) : ("concept" as const),
          conceptId,
          dropReason: d.kind === "drop" ? d.reason : null,
          decidedBy: ctx.userId,
          decidedAt: ctx.now,
          updatedAt: ctx.now,
        };
      });
      const rows = await tx
        .insert(conceptTagSortings)
        .values(decided.map((d) => ({ ...d, createdAt: ctx.now })))
        .onConflictDoUpdate({
          target: [conceptTagSortings.poolId, conceptTagSortings.tag],
          set: {
            decision: sql`excluded.decision`,
            conceptId: sql`excluded.concept_id`,
            dropReason: sql`excluded.drop_reason`,
            decidedBy: sql`excluded.decided_by`,
            decidedAt: sql`excluded.decided_at`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .returning();

      const byPool = new Map<string, { tag: string; decision: string; conceptId: string | null; reason: string | null }[]>();
      for (const d of decided) {
        const decisions = byPool.get(d.poolId) ?? [];
        if (decisions.length === 0) byPool.set(d.poolId, decisions);
        decisions.push({ tag: d.tag, decision: d.decision, conceptId: d.conceptId, reason: d.dropReason });
      }
      for (const [poolId, decisions] of byPool) {
        await audit(tx, {
          ...ctx.actor,
          action: "concept.sort",
          subjectType: "pool",
          subjectId: poolId,
          payload: { decisions },
        });
      }

      const stored = new Map(rows.map((r) => [pairKey(r), r]));
      return {
        rows: items.map(({ poolId, tag }) => {
          const row = stored.get(pairKey({ poolId, tag }))!;
          return { poolId, tag, sorting: toSorting(row, row.conceptId ? byId.get(row.conceptId)! : null) };
        }),
        created: created.map(toConcept) satisfies Concept[],
      };
    });
  } catch (error) {
    throw (await conflictOf(db, error, wanted)) ?? error;
  }
}

/**
 * A new concept's insert that hit a key's unique index: the 409
 * `concept_exists` naming each concept that holds a key the batch asked for,
 * with the items that asked. Null for any other error.
 */
async function conflictOf(
  db: Db,
  error: unknown,
  wanted: readonly NewConceptGroup<TagSortingItem>[],
): Promise<DomainError | null> {
  if (!CONCEPT_LANGS.some((lang) => isUniqueViolation(error, COLUMNS[lang].index))) return null;
  const holders = await holdersOf(
    db,
    perLang((lang) => wanted.map((c) => c.sides[lang].key)),
  );
  if (holders.length === 0) return null;
  const conflicts = holders.map((holder) => ({
    concept: toConcept(holder),
    items: wanted
      .filter((c) => CONCEPT_LANGS.some((lang) => c.sides[lang].key === holder[COLUMNS[lang].key]))
      .flatMap((c) => c.items.map(({ poolId, tag }) => ({ poolId, tag }))),
  }));
  return new DomainError("concept_exists", 409, "A concept with this label already exists", { conflicts });
}
