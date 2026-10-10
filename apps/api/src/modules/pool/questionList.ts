/** Questions: listing, search, and the metadata and version views. */
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";

import type {
  ConceptLang,
  ConceptRef,
  QuestionDraft,
  QuestionMeta,
  QuestionRow,
  QuestionSearch,
  ReviewPill,
  VersionRow,
} from "@quiz/contracts";
import { reviewPill } from "@quiz/domain";

import { likeContains, qualified, type Db } from "../../db/client.js";
import {
  coursePools,
  concepts,
  pools,
  questionConcepts,
  questionReviews,
  questionVersions,
  questions,
} from "../../db/schema.js";
import { byLabel, conceptsOf, toConceptRef } from "../concept/service.js";
import { hasKey, isParameterized, loadConfig, publicationIssuesOf, tryLoadConfig } from "./config.js";
import { exampleConfig, parameterIssues, type VersionContent } from "./instance.js";
import { openReportCounts, type ReportViewer } from "./reports.js";
import { type QuestionRecord, poolOf, type VersionRecord } from "./shared.js";
import { starredBy } from "./stars.js";

/** A cursor that does not belong to the query it was sent with (400). */
export class InvalidCursor extends Error {
  constructor(readonly reason: "malformed" | "sort_changed") {
    super(`cursor is ${reason}`);
    this.name = "InvalidCursor";
  }
}

/**
 * The keyset cursor: the SORT KEY of the last row of the page, its id, and
 * the order that produced them — base64url, opaque to the client, same shape
 * as the `(updatedAt, id)` one it replaces.
 *
 * Carrying the order is what makes a page safe: a client that changes column
 * mid-scroll sends a key that means nothing in the new order, and the API
 * refuses it (`sort_changed`) instead of returning a page that mixes two.
 */
interface Cursor {
  sort: QuestionSearch["sort"];
  dir: QuestionSearch["dir"];
  /** The sort key as text; `id` breaks the ties. */
  key: string;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string, search: QuestionSearch): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursor("malformed");
  }
  const cursor = parsed as Partial<Cursor> | null;
  if (!cursor || typeof cursor.key !== "string" || typeof cursor.id !== "string") {
    throw new InvalidCursor("malformed");
  }
  if (cursor.sort !== search.sort || cursor.dir !== search.dir) {
    throw new InvalidCursor("sort_changed");
  }
  return { sort: search.sort, dir: search.dir, key: cursor.key, id: cursor.id };
}

/**
 * The highest PUBLISHED version number of a question, as a correlated
 * subquery. `null` for a draft-only question — which is why `version:>1` and
 * `version:<3` both leave those rows out: a comparison against null is never
 * true (F-POOL-03, the `version:` filters of the search box).
 */
const latestNumber = sql<number | null>`(SELECT max(${qualified(questionVersions.number)}) FROM ${questionVersions} WHERE ${qualified(questionVersions.questionId)} = ${qualified(questions.id)})`;

/**
 * The sort key per column, as SQL and as text.
 *
 * `version` sorts NULLS LAST in both directions, which a plain `order by`
 * could express but a KEYSET comparison could not: `(key, id) < (…)` has no
 * meaning when the key is null. The null is therefore folded into a sentinel
 * that already sorts last in the requested direction, and the row comparison
 * stays a single, index-friendly expression.
 */
const SORT_KEYS = {
  name: { expr: () => sql`lower(${qualified(questions.internalName)})`, cast: "text" },
  type: { expr: () => qualified(questions.type), cast: "text" },
  difficulty: { expr: () => qualified(questions.difficulty), cast: "int" },
  version: {
    expr: (dir: QuestionSearch["dir"]) =>
      sql`coalesce(${latestNumber}, ${dir === "desc" ? -1 : 2_147_483_647})`,
    cast: "int",
  },
  updated: { expr: () => qualified(questions.updatedAt), cast: "timestamptz" },
} as const satisfies Record<
  QuestionSearch["sort"],
  { expr: (dir: QuestionSearch["dir"]) => SQL; cast: string }
>;

/** The value the database returned for the sort key, as cursor text. */
function keyText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

/**
 * The filter bar of the pool screen, as SQL. Everything is optional and
 * everything composes; the text search runs against the generated tsvector of
 * ANY version of the question plus its internal name, because a teacher
 * searches for what they wrote, published or not.
 */
function searchWhere(poolId: string, userId: string, search: QuestionSearch): SQL[] {
  const clauses = [eq(questions.poolId, poolId), ...filterWhere(search)];
  // The caller's favourites only (F-POOL-10): the same predicate that
  // computes the row's `starred` flag.
  if (search.starred) clauses.push(starredBy(userId));
  return clauses;
}

/** What {@link filterWhere} reads: the search without its order and page. */
type SearchFilters = Omit<QuestionSearch, "sort" | "dir" | "limit" | "cursor" | "starred">;

/**
 * The filters of the search box and its sheet, without the pool: shared by
 * one pool's list and the poll launcher's search across pools (issue #162),
 * so the two answer the same query the same way.
 */
function filterWhere(search: SearchFilters): SQL[] {
  const clauses: SQL[] = [];
  if (!search.includeDeleted) clauses.push(isNull(questions.deletedAt));
  if (search.categoryId) clauses.push(eq(questions.categoryId, search.categoryId));
  if (search.type?.length) clauses.push(inArray(questions.type, search.type));
  if (search.difficulty?.length) clauses.push(inArray(questions.difficulty, search.difficulty));
  if (search.concept?.length) {
    clauses.push(
      sql`EXISTS (SELECT 1 FROM ${questionConcepts} WHERE ${questionConcepts.questionId} = ${questions.id} AND ${inArray(questionConcepts.conceptId, search.concept)})`,
    );
  }
  if (search.q) {
    const like = likeContains(search.q);
    clauses.push(
      sql`(${questions.internalName} ILIKE ${like} OR EXISTS (SELECT 1 FROM ${questionVersions} WHERE ${questionVersions.questionId} = ${questions.id} AND ${questionVersions.search} @@ plainto_tsquery('simple', ${search.q})))`,
    );
  }
  // `version:>1` / `version:<3`: bounds on the HIGHEST published number. A
  // question that was never published has none, and matches neither bound.
  if (search.versionMin !== undefined) clauses.push(sql`${latestNumber} >= ${search.versionMin}`);
  if (search.versionMax !== undefined) clauses.push(sql`${latestNumber} <= ${search.versionMax}`);
  return clauses;
}

interface VersionFacts {
  latestNumber: number | null;
  publishedAt: Date | null;
  deprecated: boolean;
  draftUpdatedAt: Date | null;
  /** The latest published config, for `keyless`. */
  latest: VersionContent | null;
  /** The LLM review of the latest published version (ADR-060), or null. */
  review: ReviewPill | null;
}

/** Latest published number, its deprecation, and the draft's mtime, per question. */
async function versionFactsOf(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, VersionFacts>> {
  const out = new Map<string, VersionFacts>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      questionId: questionVersions.questionId,
      number: questionVersions.number,
      publishedAt: questionVersions.publishedAt,
      deprecatedAt: questionVersions.deprecatedAt,
      updatedAt: questionVersions.updatedAt,
      id: questionVersions.id,
      config: questionVersions.config,
      configVersion: questionVersions.configVersion,
      explanation: questionVersions.explanation,
      variables: questionVersions.variables,
      reviewState: questionReviews.state,
      reviewFindings: questionReviews.findings,
    })
    .from(questionVersions)
    .leftJoin(questionReviews, eq(questionReviews.versionId, questionVersions.id))
    .where(inArray(questionVersions.questionId, ids));
  for (const row of rows) {
    const facts = out.get(row.questionId) ?? {
      latestNumber: null,
      publishedAt: null,
      deprecated: false,
      draftUpdatedAt: null,
      latest: null,
      review: null,
    };
    if (row.number === null) {
      facts.draftUpdatedAt = row.updatedAt;
    } else if (facts.latestNumber === null || row.number > facts.latestNumber) {
      facts.latestNumber = row.number;
      facts.publishedAt = row.publishedAt;
      facts.deprecated = row.deprecatedAt !== null;
      facts.latest = {
        id: row.id,
        config: row.config,
        configVersion: row.configVersion,
        explanation: row.explanation,
        variables: row.variables,
      };
      facts.review = row.reviewState ? reviewPill(row.reviewState, row.reviewFindings ?? []) : null;
    }
    out.set(row.questionId, facts);
  }
  return out;
}

/**
 * The draft moved after the last publication. Publishing writes both rows
 * with the same timestamp, so the comparison is strict.
 */
/**
 * A published version that holds no answer key: only a question kept after
 * an opinion poll has one (ADR-014, addenda 2026-09-23). A config that no
 * longer parses is not called keyless — that is a different problem, and
 * the gates that care report it themselves.
 */
export function isKeyless(type: string, version: VersionContent | null): boolean {
  if (version === null) return false;
  try {
    // A parameterized question's key is its structure: the example instance says it.
    return !hasKey(type, exampleConfig(type, version));
  } catch {
    return false;
  }
}

function hasDraftChanges(facts: VersionFacts | undefined): boolean {
  if (!facts?.draftUpdatedAt) return false;
  if (!facts.publishedAt) return true;
  return facts.draftUpdatedAt.getTime() > facts.publishedAt.getTime();
}

function rowJson(
  question: QuestionRecord & { starred: boolean },
  concepts: ConceptRef[],
  facts: VersionFacts | undefined,
  openReports: number,
): QuestionRow {
  return {
    id: question.id,
    type: question.type,
    internalName: question.internalName,
    difficulty: question.difficulty,
    concepts,
    categoryId: question.categoryId,
    latestNumber: facts?.latestNumber ?? null,
    hasDraftChanges: hasDraftChanges(facts),
    updatedAt: question.updatedAt.toISOString(),
    deprecated: facts?.deprecated ?? false,
    deletedAt: question.deletedAt?.toISOString() ?? null,
    keyless: isKeyless(question.type, facts?.latest ?? null),
    starred: question.starred,
    randomizable: question.randomizable,
    review: facts?.review ?? null,
    openReports,
  };
}

/**
 * `GET /pools/:id/questions`: filtered, sorted on the requested column,
 * cursor-paginated, each row carrying whether the CALLER starred it and its
 * concepts labelled in `lang`.
 */
export async function listQuestions(
  db: Db,
  poolId: string,
  /** The caller; `seesAll` when they write in the pool: the open reports counted are all of them (issue #680). */
  viewer: ReportViewer,
  search: QuestionSearch,
  lang: ConceptLang,
) {
  const { page, facts, nextCursor, total } = await pageWhere(
    db,
    searchWhere(poolId, viewer.id, search),
    search,
    starredBy(viewer.id),
  );
  const ids = page.map((q) => q.id);
  const [refs, reports] = await Promise.all([
    conceptsOf(db, ids, lang),
    openReportCounts(db, ids, viewer),
  ]);
  return {
    items: page.map((q) => rowJson(q, refs.get(q.id) ?? [], facts.get(q.id), reports.get(q.id) ?? 0)),
    nextCursor,
    total,
  };
}

/**
 * One page of the questions `clauses` select, sorted and cut by `search`.
 *
 * The sort key is SELECTED as well as ordered on, so the cursor carries the
 * exact value the database produced — a `lower()` recomputed in JavaScript
 * could disagree with the collation and silently skip a row at a page break.
 */
async function pageWhere(
  db: Db,
  where: SQL[],
  search: QuestionSearch,
  /** The row's `starred` flag; false where nobody asks (the poll launcher). */
  starred: SQL = sql`false`,
) {
  const clauses = [...where];
  // Counted before the cursor narrows the clauses: the total of the search,
  // the same on every page, and not the size of the page.
  const [counted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(questions)
    .where(and(...clauses));
  const spec = SORT_KEYS[search.sort];
  const key = spec.expr(search.dir);
  const descending = search.dir === "desc";
  if (search.cursor) {
    const cursor = decodeCursor(search.cursor, search);
    // One row-value comparison, so the page break is a single predicate on
    // `(sort key, id)` — the pair the ORDER BY below is built on.
    clauses.push(
      sql`(${key}, ${qualified(questions.id)}) ${sql.raw(descending ? "<" : ">")} (${cursor.key}::${sql.raw(spec.cast)}, ${cursor.id}::uuid)`,
    );
  }
  const order = descending ? desc : asc;
  const rows = await db
    .select({ question: questions, sortKey: key, starred: sql<boolean>`${starred}`.mapWith(Boolean) })
    .from(questions)
    .where(and(...clauses))
    .orderBy(order(key), order(questions.id))
    .limit(search.limit + 1);
  const page = rows.slice(0, search.limit).map((r) => ({ ...r.question, starred: r.starred }));
  const ids = page.map((q) => q.id);
  const facts = await versionFactsOf(db, ids);
  const last = rows[search.limit - 1];
  return {
    page,
    facts,
    nextCursor:
      rows.length > search.limit && last
        ? encodeCursor({
            sort: search.sort,
            dir: search.dir,
            key: keyText(last.sortKey),
            id: last.question.id,
          })
        : null,
    total: counted?.n ?? 0,
  };
}

/** One row of a search across pools: a published question and its pool. */
interface ReachableQuestion {
  question: QuestionRecord;
  pool: { id: string; name: string };
  latestNumber: number;
  /** The latest published version, for what the caller shows of it. */
  latest: VersionContent;
}

/** The pool of a question is linked to `courseId`, on a query with `questions` in scope. */
const linkedTo = (courseId: string) =>
  sql`EXISTS (SELECT 1 FROM ${coursePools} WHERE ${qualified(coursePools.poolId)} = ${qualified(questions.poolId)} AND ${qualified(coursePools.courseId)} = ${courseId})`;

/**
 * The scope of a search across pools: the PUBLISHED, live questions of every
 * pool the caller reaches (`poolWhere`, `undefined` for an admin with Super
 * Powers), of `types` when given.
 */
function reachableScope(poolWhere: SQL | undefined, types?: readonly string[]): SQL[] {
  const reachable =
    poolWhere === undefined
      ? isNotNull(questions.poolId)
      : sql`EXISTS (SELECT 1 FROM ${pools} WHERE ${qualified(pools.id)} = ${qualified(questions.poolId)} AND ${poolWhere})`;
  const scope: SQL[] = [reachable, isNull(questions.deletedAt), sql`${latestNumber} IS NOT NULL`];
  if (types) scope.push(types.length === 0 ? sql`false` : inArray(questions.type, types));
  return scope;
}

/**
 * The rows of a search across pools, with their pool's name and their
 * latest version, by id; a row whose latest version is gone is left out.
 */
async function hydrateReachable(
  db: Db,
  page: readonly QuestionRecord[],
  facts: Map<string, VersionFacts>,
): Promise<Map<string, ReachableQuestion>> {
  const poolIds = [...new Set(page.map((q) => q.poolId).filter((id): id is string => id !== null))];
  const names =
    poolIds.length === 0
      ? new Map<string, string>()
      : new Map(
          (
            await db
              .select({ id: pools.id, name: pools.name })
              .from(pools)
              .where(inArray(pools.id, poolIds))
          ).map((p) => [p.id, p.name] as const),
        );
  const out = new Map<string, ReachableQuestion>();
  for (const question of page) {
    const fact = facts.get(question.id);
    if (!fact?.latest || fact.latestNumber === null || question.poolId === null) continue;
    out.set(question.id, {
      question,
      pool: { id: question.poolId, name: names.get(question.poolId) ?? "" },
      latestNumber: fact.latestNumber,
      latest: fact.latest,
    });
  }
  return out;
}

/**
 * The PUBLISHED, live questions of every pool the caller reaches, searched
 * with the grammar of the pool screen (issue #162, the poll launcher's
 * "From pools"). `poolWhere` is the pool predicate of the caller —
 * `undefined` for an admin — and `courseId`, when set, narrows to the pools
 * linked to that course. `types` is what the caller can run: a `type:`
 * filter outside it matches nothing rather than widening the search.
 *
 * Each row carries its concepts, and `concepts` is every concept of the
 * SCOPE (the filters left out), for the filter sheet and the `#` completion,
 * the way a pool's own concepts feed its bar; all labelled in `lang`.
 */
export async function searchReachableQuestions(
  db: Db,
  input: {
    poolWhere: SQL | undefined;
    courseId: string | null;
    types: readonly string[];
    search: QuestionSearch;
    /** Leave out the parameterized questions (ADR-056 §10): a poll's picker. */
    staticOnly?: boolean;
    lang: ConceptLang;
  },
): Promise<{
  items: (ReachableQuestion & { concepts: ConceptRef[] })[];
  nextCursor: string | null;
  total: number;
  concepts: ConceptRef[];
}> {
  const { search } = input;
  const types = search.type?.length
    ? input.types.filter((t) => search.type!.includes(t))
    : [...input.types];
  const scope = reachableScope(input.poolWhere, types);
  if (input.courseId !== null) scope.push(linkedTo(input.courseId));
  if (input.staticOnly) scope.push(eq(questions.randomizable, false));
  const filters = filterWhere({ ...search, type: undefined, categoryId: undefined, includeDeleted: false });
  const [{ page, facts, nextCursor, total }, scopeConcepts] = await Promise.all([
    pageWhere(db, [...scope, ...filters], search),
    db
      .selectDistinct({ concept: concepts })
      .from(questionConcepts)
      .innerJoin(questions, eq(questions.id, questionConcepts.questionId))
      .innerJoin(concepts, eq(concepts.id, questionConcepts.conceptId))
      .where(and(...scope)),
  ]);
  const [rows, refs] = await Promise.all([
    hydrateReachable(db, page, facts),
    conceptsOf(db, page.map((q) => q.id), input.lang),
  ]);
  return {
    items: page.flatMap((q) => {
      const row = rows.get(q.id);
      return row ? [{ ...row, concepts: refs.get(q.id) ?? [] }] : [];
    }),
    nextCursor,
    total,
    concepts: scopeConcepts.map((r) => toConceptRef(r.concept, input.lang)).sort(byLabel),
  };
}

/** One hit of {@link rankReachableQuestions}. */
export interface RankedQuestion extends ReachableQuestion {
  /** Its pool is linked to the course searched for. */
  linked: boolean;
  /** The latest published version's indexed text (`search_text`). */
  searchText: string;
}

/**
 * The questions of the same scope closest to a statement (ADR-022, addendum
 * of 2026-10-01): those whose LATEST published version shares at least one
 * of `terms` (an OR of them, from `similarityTerms`), the ones of the pools
 * linked to `courseId` first, then best rank first; the top `limit`, no
 * threshold. No term, no hit.
 *
 * The rank is `ts_rank(search, query, 1)`: on an OR query it grows with each
 * DISTINCT term matched (a repeated word adds less and less), and the
 * normalisation `1` divides it by `1 + log(length)` so that a long code
 * template does not outrank a short statement by sheer bulk. `ts_rank_cd`
 * was not taken: with an OR query every occurrence is its own cover, so it
 * counts occurrences rather than shared words. The index is a `simple`
 * tsvector (no stemming, no stop words), which is why the terms come
 * stripped of short and common words.
 */
export async function rankReachableQuestions(
  db: Db,
  input: {
    poolWhere: SQL | undefined;
    courseId: string;
    terms: readonly string[];
    limit: number;
    type?: string | undefined;
  },
): Promise<RankedQuestion[]> {
  if (input.terms.length === 0) return [];
  // Letters and digits only (`similarityTerms`), so the join needs no escaping.
  const query = sql`to_tsquery('simple', ${input.terms.join(" | ")})`;
  const search = qualified(questionVersions.search);
  const linked = linkedTo(input.courseId);
  const rows = await db
    .select({
      question: questions,
      linked: sql<boolean>`${linked}`.mapWith(Boolean),
      searchText: questionVersions.searchText,
    })
    .from(questions)
    .innerJoin(
      questionVersions,
      and(eq(questionVersions.questionId, questions.id), sql`${qualified(questionVersions.number)} = ${latestNumber}`),
    )
    .where(and(...reachableScope(input.poolWhere, input.type ? [input.type] : undefined), sql`${search} @@ ${query}`))
    .orderBy(sql`${linked} DESC`, sql`ts_rank(${search}, ${query}, 1) DESC`, asc(questions.id))
    .limit(input.limit);
  const page = rows.map((r) => r.question);
  const ids = page.map((q) => q.id);
  const hydrated = await hydrateReachable(db, page, await versionFactsOf(db, ids));
  return rows.flatMap((r) => {
    const row = hydrated.get(r.question.id);
    return row ? [{ ...row, linked: r.linked, searchText: r.searchText }] : [];
  });
}

export function metaJson(question: QuestionRecord, concepts: ConceptRef[]): QuestionMeta {
  return {
    id: question.id,
    poolId: poolOf(question),
    type: question.type,
    internalName: question.internalName,
    categoryId: question.categoryId,
    difficulty: question.difficulty,
    shuffleable: question.shuffleable,
    randomizable: question.randomizable,
    concepts,
    createdBy: question.createdBy,
    originQuestionId: question.originQuestionId,
    deletedAt: question.deletedAt?.toISOString() ?? null,
    updatedAt: question.updatedAt.toISOString(),
  };
}

export function versionJson(row: VersionRecord): VersionRow {
  return {
    number: row.number!,
    publishedAt: (row.publishedAt ?? row.updatedAt).toISOString(),
    publishedBy: row.publishedBy,
    changeNote: row.changeNote,
    deprecatedAt: row.deprecatedAt?.toISOString() ?? null,
    deprecationNote: row.deprecationNote,
  };
}

export function draftJson(type: string, row: VersionRecord): QuestionDraft {
  // A parameterized draft is handed back as its TEMPLATE, formulas and all (ADR-056).
  const outcome = tryLoadConfig(type, row, { template: true });
  return {
    // MIGRATED either way (the editor always works at the current schema),
    // and never re-validated when it does not parse: the teacher must not
    // lose the half-written work `PUT /draft` accepted (D16). An invalid
    // draft handed back at its OLD shape is what used to be written straight
    // back under the current version number — see `tryLoadConfig`.
    config: outcome.config,
    explanation: row.explanation,
    variables: row.variables,
    configVersion: row.configVersion,
    updatedAt: row.updatedAt.toISOString(),
    // "Valid" means publishable, the flag the editor's Publish button reads.
    // A parameterized draft is publishable when its INSTANCES are (ADR-056):
    // its template need not satisfy the schema at all.
    valid: isParameterized(row)
      ? parameterIssues(type, row).length === 0
      : outcome.ok && publicationIssuesOf(type, outcome.config).length === 0,
  };
}
