/**
 * The `pool` module's business layer: pools, categories, questions, their
 * versions. Routes call this file; no other module reads it except through
 * the few functions the plan lets them (`setCoursePools`, `poolsOfCourse`).
 *
 * Two rules shape everything here:
 *   - a stored config is only ever read and written through `./config.ts`
 *     (PLAN-MVP §1.6), never parsed inline;
 *   - a question's content lives in `question_versions`, never in
 *     `questions`; publishing is ONE transaction guarded by two unique
 *     indexes (see `db/pool.ts`).
 */
import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";

import type {
  Category,
  CategoryNode,
  QuestionDetail,
  QuestionDraft,
  QuestionMeta,
  QuestionRow,
  QuestionSearch,
  VersionDetail,
  VersionRow,
  ZodIssueLite,
} from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import {
  categories,
  coursePools,
  pools,
  questionTags,
  questionVersions,
  questions,
} from "../../db/schema.js";
import {
  issuesOf,
  loadConfig,
  saveConfig,
  saveDraftConfig,
  searchTextOf,
  tryLoadConfig,
  typeOf,
} from "./config.js";

type PoolRow = typeof pools.$inferSelect;
type QuestionRecord = typeof questions.$inferSelect;
type VersionRecord = typeof questionVersions.$inferSelect;

/** A draft cannot be published while its config does not satisfy the schema (D16). */
export class DraftInvalid extends Error {
  constructor(readonly issues: ZodIssueLite[]) {
    super("draft config is invalid");
    this.name = "DraftInvalid";
  }
}

/** The question has no draft row at all — a corrupted question, never normal. */
export class MissingDraft extends Error {
  constructor() {
    super("question has no draft");
    this.name = "MissingDraft";
  }
}

/** A published version is referenced by an evaluation item (`409 in_use`). */
export class VersionInUse extends Error {
  constructor() {
    super("a published version is in use");
    this.name = "VersionInUse";
  }
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

const questionCount = sql<number>`(SELECT count(*) FROM ${questions} WHERE ${questions.poolId} = ${pools.id} AND ${questions.deletedAt} IS NULL)::int`;

function poolJson(pool: PoolRow) {
  return {
    id: pool.id,
    name: pool.name,
    visibility: pool.visibility,
    ownerId: pool.ownerId,
    isPersonal: pool.isPersonal,
    createdAt: pool.createdAt.toISOString(),
  };
}

/** Every pool the predicate lets the caller see, with its question count. */
export async function listPools(db: Db, where: SQL | undefined) {
  const rows = await db
    .select({ pool: pools, questionCount })
    .from(pools)
    .where(where)
    .orderBy(asc(pools.name));
  return rows.map((r) => ({ ...poolJson(r.pool), questionCount: r.questionCount }));
}

export async function createPool(
  db: Db,
  input: { name: string; visibility: "private" | "shared" | "public"; ownerId: string },
) {
  const [row] = await db
    .insert(pools)
    .values({ id: randomUUID(), name: input.name, visibility: input.visibility, ownerId: input.ownerId })
    .returning();
  return poolJson(row!);
}

export async function updatePool(
  db: Db,
  poolId: string,
  patch: { name?: string | undefined; visibility?: "private" | "shared" | "public" | undefined },
) {
  const [row] = await db
    .update(pools)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(pools.id, poolId))
    .returning();
  return poolJson(row!);
}

export async function deletePool(db: Db, poolId: string): Promise<void> {
  await db.delete(pools).where(eq(pools.id, poolId));
}

/** `GET /pools/:id`: the pool, its category tree and the tags in use. */
export async function poolDetail(db: Db, pool: PoolRow) {
  const [tree, tags, [counted]] = await Promise.all([
    categoryTree(db, pool.id),
    poolTags(db, pool.id),
    db.select({ n: questionCount }).from(pools).where(eq(pools.id, pool.id)),
  ]);
  return {
    pool: poolJson(pool),
    categories: tree,
    tags,
    questionCount: counted?.n ?? 0,
  };
}

/** The distinct tags used by the live questions of a pool, alphabetical. */
export async function poolTags(db: Db, poolId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tag: questionTags.tag })
    .from(questionTags)
    .innerJoin(questions, eq(questionTags.questionId, questions.id))
    .where(and(eq(questions.poolId, poolId), isNull(questions.deletedAt)))
    .orderBy(asc(questionTags.tag));
  return rows.map((r) => r.tag);
}

// --- `course_pools`: written here, called by the `org` module -------------

export async function poolsOfCourse(db: Db, courseId: string) {
  const rows = await db
    .select({ pool: pools, questionCount })
    .from(coursePools)
    .innerJoin(pools, eq(coursePools.poolId, pools.id))
    .where(eq(coursePools.courseId, courseId))
    .orderBy(asc(pools.name));
  return rows.map((r) => ({ ...poolJson(r.pool), questionCount: r.questionCount }));
}

/**
 * Replaces the whole set of pools a course draws from. Only pools the caller
 * can already reach may be linked, hence `allowed`: linking someone else's
 * pool would grant the whole staff access to it.
 */
export async function setCoursePools(
  db: Db,
  courseId: string,
  poolIds: readonly string[],
  allowed: SQL | undefined,
) {
  const unique = [...new Set(poolIds)];
  const reachable = unique.length
    ? (
        await db
          .select({ id: pools.id })
          .from(pools)
          .where(and(inArray(pools.id, unique), allowed))
      ).map((r) => r.id)
    : [];
  await db.transaction(async (tx) => {
    await tx.delete(coursePools).where(eq(coursePools.courseId, courseId));
    if (reachable.length) {
      await tx
        .insert(coursePools)
        .values(reachable.map((poolId) => ({ courseId, poolId })));
    }
  });
  return poolsOfCourse(db, courseId);
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

function categoryJson(row: typeof categories.$inferSelect): Category {
  return {
    id: row.id,
    poolId: row.poolId,
    parentId: row.parentId,
    name: row.name,
    position: row.position,
  };
}

/** The folders of a pool as a tree; siblings ordered by `position` then name. */
export async function categoryTree(db: Db, poolId: string): Promise<CategoryNode[]> {
  const rows = await db
    .select()
    .from(categories)
    .where(eq(categories.poolId, poolId))
    .orderBy(asc(categories.position), asc(categories.name));
  const nodes = new Map<string, CategoryNode>(
    rows.map((r) => [r.id, { ...categoryJson(r), children: [] }]),
  );
  const roots: CategoryNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parentId ? nodes.get(row.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export async function createCategory(
  db: Db,
  poolId: string,
  input: { name: string; parentId?: string | null | undefined },
): Promise<Category> {
  const parentId = input.parentId ?? null;
  const [last] = await db
    .select({ max: sql<number>`coalesce(max(${categories.position}), -1)::int` })
    .from(categories)
    .where(
      and(
        eq(categories.poolId, poolId),
        parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId),
      ),
    );
  const [row] = await db
    .insert(categories)
    .values({
      id: randomUUID(),
      poolId,
      parentId,
      name: input.name,
      position: (last?.max ?? -1) + 1,
    })
    .returning();
  return categoryJson(row!);
}

/**
 * A folder cannot become its own descendant; the walk up the parent chain is
 * what keeps the tree a tree (the database only knows the edge is valid).
 */
export async function wouldCycle(
  db: Db,
  categoryId: string,
  newParentId: string | null,
): Promise<boolean> {
  let cursor = newParentId;
  for (let hops = 0; cursor !== null && hops < 64; hops += 1) {
    if (cursor === categoryId) return true;
    const [row] = await db
      .select({ parentId: categories.parentId })
      .from(categories)
      .where(eq(categories.id, cursor))
      .limit(1);
    if (!row) return false;
    cursor = row.parentId;
  }
  return false;
}

export async function updateCategory(
  db: Db,
  categoryId: string,
  patch: {
    name?: string | undefined;
    parentId?: string | null | undefined;
    position?: number | undefined;
  },
): Promise<Category> {
  const [row] = await db
    .update(categories)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
    })
    .where(eq(categories.id, categoryId))
    .returning();
  return categoryJson(row!);
}

/**
 * Drag-and-drop reorder of the whole tree in one call. Only the rows of this
 * pool are touched, so a crafted payload cannot move a folder into another
 * pool's tree.
 */
export async function reorderCategories(
  db: Db,
  poolId: string,
  items: readonly { id: string; parentId: string | null; position: number }[],
): Promise<CategoryNode[]> {
  await db.transaction(async (tx) => {
    for (const item of items) {
      await tx
        .update(categories)
        .set({ parentId: item.parentId, position: item.position })
        .where(and(eq(categories.id, item.id), eq(categories.poolId, poolId)));
    }
  });
  return categoryTree(db, poolId);
}

/** Deleting a folder deletes its subtree; its questions fall back to the root. */
export async function deleteCategory(db: Db, categoryId: string): Promise<void> {
  await db.delete(categories).where(eq(categories.id, categoryId));
}

// ---------------------------------------------------------------------------
// Questions — listing and metadata
// ---------------------------------------------------------------------------

/** `(updatedAt, id)` of the last row of a page, opaque to the client. */
function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { updatedAt: Date; id: string } | null {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const bar = raw.lastIndexOf("|");
  if (bar <= 0) return null;
  const updatedAt = new Date(raw.slice(0, bar));
  const id = raw.slice(bar + 1);
  if (Number.isNaN(updatedAt.getTime()) || id.length === 0) return null;
  return { updatedAt, id };
}

/**
 * The filter bar of the pool screen, as SQL. Everything is optional and
 * everything composes; the text search runs against the generated tsvector of
 * ANY version of the question plus its internal name, because a teacher
 * searches for what they wrote, published or not.
 */
function searchWhere(poolId: string, search: QuestionSearch): SQL[] {
  const clauses: SQL[] = [eq(questions.poolId, poolId)];
  if (!search.includeDeleted) clauses.push(isNull(questions.deletedAt));
  if (search.categoryId) clauses.push(eq(questions.categoryId, search.categoryId));
  if (search.type?.length) clauses.push(inArray(questions.type, search.type));
  if (search.difficulty?.length) clauses.push(inArray(questions.difficulty, search.difficulty));
  if (search.tag?.length) {
    clauses.push(
      sql`EXISTS (SELECT 1 FROM ${questionTags} WHERE ${questionTags.questionId} = ${questions.id} AND ${inArray(questionTags.tag, search.tag)})`,
    );
  }
  if (search.q) {
    const like = `%${search.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    clauses.push(
      sql`(${questions.internalName} ILIKE ${like} OR EXISTS (SELECT 1 FROM ${questionVersions} WHERE ${questionVersions.questionId} = ${questions.id} AND ${questionVersions.search} @@ plainto_tsquery('simple', ${search.q})))`,
    );
  }
  return clauses;
}

/** Tags of a set of questions, in one query. */
async function tagsOf(db: Db, ids: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = await db
    .select()
    .from(questionTags)
    .where(inArray(questionTags.questionId, ids))
    .orderBy(asc(questionTags.tag));
  for (const row of rows) {
    const list = out.get(row.questionId) ?? [];
    list.push(row.tag);
    out.set(row.questionId, list);
  }
  return out;
}

interface VersionFacts {
  latestNumber: number | null;
  publishedAt: Date | null;
  deprecated: boolean;
  draftUpdatedAt: Date | null;
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
    })
    .from(questionVersions)
    .where(inArray(questionVersions.questionId, ids));
  for (const row of rows) {
    const facts = out.get(row.questionId) ?? {
      latestNumber: null,
      publishedAt: null,
      deprecated: false,
      draftUpdatedAt: null,
    };
    if (row.number === null) {
      facts.draftUpdatedAt = row.updatedAt;
    } else if (facts.latestNumber === null || row.number > facts.latestNumber) {
      facts.latestNumber = row.number;
      facts.publishedAt = row.publishedAt;
      facts.deprecated = row.deprecatedAt !== null;
    }
    out.set(row.questionId, facts);
  }
  return out;
}

/**
 * The draft moved after the last publication. Publishing writes both rows
 * with the same timestamp, so the comparison is strict.
 */
function hasDraftChanges(facts: VersionFacts | undefined): boolean {
  if (!facts?.draftUpdatedAt) return false;
  if (!facts.publishedAt) return true;
  return facts.draftUpdatedAt.getTime() > facts.publishedAt.getTime();
}

function rowJson(
  question: QuestionRecord,
  tags: string[],
  facts: VersionFacts | undefined,
): QuestionRow {
  return {
    id: question.id,
    type: question.type,
    internalName: question.internalName,
    difficulty: question.difficulty,
    tags,
    categoryId: question.categoryId,
    latestNumber: facts?.latestNumber ?? null,
    hasDraftChanges: hasDraftChanges(facts),
    updatedAt: question.updatedAt.toISOString(),
    deprecated: facts?.deprecated ?? false,
    deletedAt: question.deletedAt?.toISOString() ?? null,
  };
}

/** `GET /pools/:id/questions`: filtered, newest first, cursor-paginated. */
export async function listQuestions(db: Db, poolId: string, search: QuestionSearch) {
  const clauses = searchWhere(poolId, search);
  const cursor = search.cursor ? decodeCursor(search.cursor) : null;
  if (cursor) {
    clauses.push(
      sql`(${questions.updatedAt}, ${questions.id}) < (${cursor.updatedAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
    );
  }
  const rows = await db
    .select()
    .from(questions)
    .where(and(...clauses))
    .orderBy(desc(questions.updatedAt), desc(questions.id))
    .limit(search.limit + 1);
  const page = rows.slice(0, search.limit);
  const ids = page.map((r) => r.id);
  const [tags, facts] = await Promise.all([tagsOf(db, ids), versionFactsOf(db, ids)]);
  const last = page.at(-1);
  return {
    items: page.map((q) => rowJson(q, tags.get(q.id) ?? [], facts.get(q.id))),
    nextCursor: rows.length > search.limit && last ? encodeCursor(last.updatedAt, last.id) : null,
  };
}

function metaJson(question: QuestionRecord, tags: string[]): QuestionMeta {
  return {
    id: question.id,
    poolId: question.poolId,
    type: question.type,
    internalName: question.internalName,
    categoryId: question.categoryId,
    difficulty: question.difficulty,
    shuffleable: question.shuffleable,
    randomizable: question.randomizable,
    tags,
    createdBy: question.createdBy,
    originQuestionId: question.originQuestionId,
    deletedAt: question.deletedAt?.toISOString() ?? null,
    updatedAt: question.updatedAt.toISOString(),
  };
}

function versionJson(row: VersionRecord): VersionRow {
  return {
    number: row.number!,
    publishedAt: (row.publishedAt ?? row.updatedAt).toISOString(),
    publishedBy: row.publishedBy,
    changeNote: row.changeNote,
    deprecatedAt: row.deprecatedAt?.toISOString() ?? null,
    deprecationNote: row.deprecationNote,
  };
}

function draftJson(type: string, row: VersionRecord): QuestionDraft {
  const outcome = tryLoadConfig(type, row);
  return {
    // A valid config is returned MIGRATED (the editor always works at the
    // current schema); an invalid one comes back exactly as stored, or the
    // teacher loses the half-written work `PUT /draft` accepted (D16).
    config: outcome.ok ? outcome.config : row.config,
    explanation: row.explanation,
    configVersion: row.configVersion,
    updatedAt: row.updatedAt.toISOString(),
    valid: outcome.ok,
  };
}

// ---------------------------------------------------------------------------
// Questions — the write path
// ---------------------------------------------------------------------------

/**
 * A new question and its first draft, pre-filled by the type's
 * `emptyDraft()` — the only place a config is born.
 */
export async function createQuestion(
  db: Db,
  input: {
    poolId: string;
    type: string;
    internalName: string;
    categoryId?: string | null;
    createdBy: string;
  },
): Promise<string> {
  const t = typeOf(input.type);
  const config = saveConfig(input.type, t.emptyDraft());
  const id = randomUUID();
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(questions).values({
      id,
      poolId: input.poolId,
      type: input.type,
      internalName: input.internalName,
      categoryId: input.categoryId ?? null,
      createdBy: input.createdBy,
      shuffleable: t.shuffleable(config.config),
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(questionVersions).values({
      id: randomUUID(),
      questionId: id,
      number: null,
      config: config.config,
      configVersion: config.configVersion,
      searchText: searchTextOf(input.type, input.internalName, config.config),
      updatedAt: now,
      createdAt: now,
    });
  });
  return id;
}

/** The draft row of a question (`number is null`), or `MissingDraft`. */
export async function draftOf(db: Db, questionId: string): Promise<VersionRecord> {
  const [row] = await db
    .select()
    .from(questionVersions)
    .where(and(eq(questionVersions.questionId, questionId), isNull(questionVersions.number)))
    .limit(1);
  if (!row) throw new MissingDraft();
  return row;
}

export async function questionDetail(db: Db, question: QuestionRecord): Promise<QuestionDetail> {
  const [draft, versions, tags] = await Promise.all([
    draftOf(db, question.id),
    db
      .select()
      .from(questionVersions)
      .where(
        and(eq(questionVersions.questionId, question.id), isNotNull(questionVersions.number)),
      )
      .orderBy(desc(questionVersions.number)),
    tagsOf(db, [question.id]),
  ]);
  const rows = versions.map(versionJson);
  return {
    meta: metaJson(question, tags.get(question.id) ?? []),
    draft: draftJson(question.type, draft),
    versions: rows,
    latestPublished: rows[0] ?? null,
  };
}

/**
 * Metadata only. Renaming also refreshes the draft's `search_text`, so the
 * full-text index follows the name the teacher searches by.
 */
export async function patchQuestion(
  db: Db,
  question: QuestionRecord,
  patch: {
    internalName?: string | undefined;
    categoryId?: string | null | undefined;
    difficulty?: number | undefined;
    shuffleable?: boolean | undefined;
    randomizable?: boolean | undefined;
    tags?: readonly string[] | undefined;
  },
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(questions)
      .set({
        ...(patch.internalName !== undefined ? { internalName: patch.internalName } : {}),
        ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
        ...(patch.difficulty !== undefined ? { difficulty: patch.difficulty } : {}),
        ...(patch.shuffleable !== undefined ? { shuffleable: patch.shuffleable } : {}),
        ...(patch.randomizable !== undefined ? { randomizable: patch.randomizable } : {}),
        updatedAt: now,
      })
      .where(eq(questions.id, question.id));
    if (patch.tags) {
      const unique = [...new Set(patch.tags.map((t) => t.trim().toLowerCase()))].filter(Boolean);
      await tx.delete(questionTags).where(eq(questionTags.questionId, question.id));
      if (unique.length) {
        await tx
          .insert(questionTags)
          .values(unique.map((tag) => ({ questionId: question.id, tag })));
      }
    }
    if (patch.internalName !== undefined) {
      const [draft] = await tx
        .select()
        .from(questionVersions)
        .where(
          and(eq(questionVersions.questionId, question.id), isNull(questionVersions.number)),
        )
        .limit(1);
      if (draft) {
        await tx
          .update(questionVersions)
          .set({
            searchText: searchTextOf(question.type, patch.internalName, draft.config),
          })
          .where(eq(questionVersions.id, draft.id));
      }
    }
  });
}

/**
 * Autosave (F-QST-02, decision D16): the config is STORED even when it does
 * not parse, and the issues travel back so the editor can underline them.
 * Nothing here can fail on content.
 */
export async function putDraft(
  db: Db,
  question: QuestionRecord,
  body: { config: unknown; explanation?: string },
): Promise<{ updatedAt: string; valid: boolean; issues: ZodIssueLite[] }> {
  const draft = await draftOf(db, question.id);
  const { row, issues } = saveDraftConfig(question.type, body.config);
  const explanation = body.explanation ?? draft.explanation;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(questionVersions)
      .set({
        config: row.config,
        configVersion: row.configVersion,
        explanation,
        searchText: searchTextOf(question.type, question.internalName, row.config),
        updatedAt: now,
      })
      .where(eq(questionVersions.id, draft.id));
    await tx.update(questions).set({ updatedAt: now }).where(eq(questions.id, question.id));
  });
  return { updatedAt: now.toISOString(), valid: issues.length === 0, issues };
}

/**
 * Publication (F-QST-03) in ONE transaction: the draft BECOMES version
 * `max + 1` and a fresh draft is opened with the same content. The partial
 * unique index `(question_id) where number is null` is what makes two
 * simultaneous publications resolve to one winner — the loser's insert of
 * the new draft violates it and its whole transaction rolls back.
 */
export async function publishQuestion(
  db: Db,
  question: QuestionRecord,
  input: { userId: string; changeNote?: string },
): Promise<VersionRow> {
  return db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(questionVersions)
      .where(and(eq(questionVersions.questionId, question.id), isNull(questionVersions.number)))
      .for("update")
      .limit(1);
    if (!draft) throw new MissingDraft();

    // Full parse here, and only here: this is the gate D16 moves the
    // validation to.
    let config: unknown;
    try {
      config = saveConfig(question.type, loadConfig(question.type, draft)).config;
    } catch (error) {
      throw new DraftInvalid(issuesOf(error));
    }
    const configVersion = typeOf(question.type).configVersion;
    const searchText = searchTextOf(question.type, question.internalName, config);

    const [highest] = await tx
      .select({ max: sql<number>`coalesce(max(${questionVersions.number}), 0)::int` })
      .from(questionVersions)
      .where(eq(questionVersions.questionId, question.id));
    const number = (highest?.max ?? 0) + 1;
    const now = new Date();

    const [published] = await tx
      .update(questionVersions)
      .set({
        number,
        config,
        configVersion,
        searchText,
        publishedAt: now,
        publishedBy: input.userId,
        changeNote: input.changeNote ?? null,
        updatedAt: now,
      })
      .where(eq(questionVersions.id, draft.id))
      .returning();

    await tx.insert(questionVersions).values({
      id: randomUUID(),
      questionId: question.id,
      number: null,
      config,
      configVersion,
      explanation: draft.explanation,
      searchText,
      updatedAt: now,
      createdAt: now,
    });
    await tx.update(questions).set({ updatedAt: now }).where(eq(questions.id, question.id));
    return versionJson(published!);
  });
}

/** One published version, config migrated to the current shape. */
export async function versionDetail(
  db: Db,
  question: QuestionRecord,
  number: number,
): Promise<VersionDetail | null> {
  const row = await versionRow(db, question.id, number);
  if (!row) return null;
  return {
    ...versionJson(row),
    config: loadConfig(question.type, row),
    explanation: row.explanation,
    configVersion: row.configVersion,
  };
}

export async function versionRow(
  db: Db,
  questionId: string,
  number: number,
): Promise<VersionRecord | null> {
  const [row] = await db
    .select()
    .from(questionVersions)
    .where(and(eq(questionVersions.questionId, questionId), eq(questionVersions.number, number)))
    .limit(1);
  return row ?? null;
}

export async function listVersions(db: Db, questionId: string): Promise<VersionRow[]> {
  const rows = await db
    .select()
    .from(questionVersions)
    .where(and(eq(questionVersions.questionId, questionId), isNotNull(questionVersions.number)))
    .orderBy(desc(questionVersions.number));
  return rows.map(versionJson);
}

/** Copies a published version back into the draft (F-QST-05). */
export async function restoreVersion(
  db: Db,
  question: QuestionRecord,
  number: number,
): Promise<boolean> {
  const source = await versionRow(db, question.id, number);
  if (!source) return false;
  const draft = await draftOf(db, question.id);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(questionVersions)
      .set({
        config: source.config,
        configVersion: source.configVersion,
        explanation: source.explanation,
        searchText: source.searchText,
        updatedAt: now,
      })
      .where(eq(questionVersions.id, draft.id));
    await tx.update(questions).set({ updatedAt: now }).where(eq(questions.id, question.id));
  });
  return true;
}

/** Marks a version as not-to-be-used-any-more; existing evaluations keep it. */
export async function deprecateVersion(
  db: Db,
  questionId: string,
  number: number,
  note: string,
): Promise<VersionRow | null> {
  const [row] = await db
    .update(questionVersions)
    .set({ deprecatedAt: new Date(), deprecationNote: note })
    .where(and(eq(questionVersions.questionId, questionId), eq(questionVersions.number, number)))
    .returning();
  return row ? versionJson(row) : null;
}

/**
 * Is a published version referenced by an evaluation?
 *
 * TODO(WP5): `evaluation_items` does not exist yet — the table lands with the
 * `evaluation` module, and this becomes
 * `select 1 from evaluation_items where question_version_id = $1`. Until
 * then nothing can reference a version, so the honest answer is `false` and
 * the `409 in_use` branch is already wired and tested by its caller.
 */
export async function isVersionInUse(_db: Db, _versionId: string): Promise<boolean> {
  return false;
}

/** True when ANY published version of the question is referenced (WP5). */
export async function isQuestionInUse(db: Db, questionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: questionVersions.id })
    .from(questionVersions)
    .where(
      and(eq(questionVersions.questionId, questionId), isNotNull(questionVersions.number)),
    );
  for (const row of rows) {
    if (await isVersionInUse(db, row.id)) return true;
  }
  return false;
}

/**
 * Soft delete (F-QST-11): the question leaves the pool but its published
 * versions stay readable, because an evaluation may have frozen one. A
 * question an evaluation still points at cannot be removed at all.
 */
export async function softDeleteQuestion(db: Db, question: QuestionRecord): Promise<void> {
  if (await isQuestionInUse(db, question.id)) throw new VersionInUse();
  const now = new Date();
  await db
    .update(questions)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(questions.id, question.id));
}

export async function restoreQuestion(db: Db, question: QuestionRecord): Promise<void> {
  const now = new Date();
  await db
    .update(questions)
    .set({ deletedAt: null, updatedAt: now })
    .where(eq(questions.id, question.id));
}

/** `?hard=1`: the rows really go away (cascade on versions and tags). */
export async function hardDeleteQuestion(db: Db, question: QuestionRecord): Promise<void> {
  if (await isQuestionInUse(db, question.id)) throw new VersionInUse();
  await db.delete(questions).where(eq(questions.id, question.id));
}

/**
 * Copies a question into a pool: metadata, tags and the CURRENT draft — not
 * the history, which belongs to the original. The copy keeps a pointer to
 * its origin so a teacher can tell where it came from.
 */
export async function copyQuestion(
  db: Db,
  question: QuestionRecord,
  input: { targetPoolId: string; categoryId?: string | null; userId: string },
): Promise<string> {
  const draft = await draftOf(db, question.id);
  const tags = (await tagsOf(db, [question.id])).get(question.id) ?? [];
  const id = randomUUID();
  const now = new Date();
  const name = await freeName(db, input.targetPoolId, question.internalName);
  await db.transaction(async (tx) => {
    await tx.insert(questions).values({
      id,
      poolId: input.targetPoolId,
      type: question.type,
      internalName: name,
      categoryId: input.categoryId ?? null,
      difficulty: question.difficulty,
      shuffleable: question.shuffleable,
      randomizable: question.randomizable,
      createdBy: input.userId,
      originQuestionId: question.id,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(questionVersions).values({
      id: randomUUID(),
      questionId: id,
      number: null,
      config: draft.config,
      configVersion: draft.configVersion,
      explanation: draft.explanation,
      searchText: searchTextOf(question.type, name, draft.config),
      updatedAt: now,
      createdAt: now,
    });
    if (tags.length) {
      await tx.insert(questionTags).values(tags.map((tag) => ({ questionId: id, tag })));
    }
  });
  return id;
}

/**
 * `questions_pool_name_uq` is case-insensitive and per pool: a copy landing
 * next to its original needs a name of its own, chosen here rather than
 * discovered as a 409 by the teacher.
 */
async function freeName(db: Db, poolId: string, name: string): Promise<string> {
  for (let n = 0; n < 50; n += 1) {
    const candidate = n === 0 ? name : n === 1 ? `${name} (copy)` : `${name} (copy ${n})`;
    const [taken] = await db
      .select({ id: questions.id })
      .from(questions)
      .where(
        and(
          eq(questions.poolId, poolId),
          isNull(questions.deletedAt),
          sql`lower(${questions.internalName}) = lower(${candidate})`,
        ),
      )
      .limit(1);
    if (!taken) return candidate;
  }
  return `${name} ${randomUUID().slice(0, 8)}`;
}
