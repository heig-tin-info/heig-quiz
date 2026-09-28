/** Questions: the write path (create, draft, publish, versions, delete, copy). */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

import type { QuestionDetail, VersionDetail, VersionRow, ZodIssueLite } from "@quiz/contracts";
import { issuesOf } from "@quiz/contracts";

import { isUniqueViolation, type Db } from "../../db/client.js";
import {
  assets,
  attempts,
  evaluationItems,
  evaluations,
  questionTags,
  questionVersionAssets,
  questionVersions,
  questions,
} from "../../db/schema.js";
import { userTopic } from "../realtime/bus.js";
import { poolChanged, poolPeopleChanged } from "./events.js";
import {
  loadConfig,
  NotPublishable,
  publishConfig,
  saveConfig,
  saveDraftConfig,
  searchTextOf,
  typeOf,
} from "./config.js";
import {
  type QuestionRecord,
  poolOf,
  type VersionRecord,
  DraftInvalid,
  MissingDraft,
  VersionInUse,
  assertCategoryOf,
  questionWriteError,
} from "./shared.js";
import { ensurePersonalPool } from "./pools.js";
import { normalizeTag, ensurePoolTags } from "./tags.js";
import { tagsOf, isKeyless, metaJson, versionJson, draftJson } from "./questionList.js";

/**
 * A new question and its first draft, pre-filled by the type's
 * `emptyDraft()` — the only place a config is born.
 *
 * That draft is EMPTY, so it does not satisfy the type's schema: it goes
 * through `saveDraftConfig`, exactly like the autosave of `putDraft`, and is
 * stored as it stands (decision D16). Refusing it here would mean no teacher
 * could ever create a question.
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
): Promise<QuestionRecord> {
  const t = typeOf(input.type);
  const { row: config } = saveDraftConfig(input.type, t.emptyDraft());
  const id = randomUUID();
  const now = new Date();
  return db.transaction(async (tx) => {
    await assertCategoryOf(tx, input.poolId, input.categoryId);
    const [created] = await tx.insert(questions).values({
      id,
      poolId: input.poolId,
      type: input.type,
      internalName: input.internalName,
      categoryId: input.categoryId ?? null,
      createdBy: input.createdBy,
      shuffleable: t.shuffleable(config.config),
      createdAt: now,
      updatedAt: now,
    }).returning();
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
    return created!;
  }).catch((error: unknown) => {
    throw questionWriteError(error);
  });
}

/**
 * A question that belongs to NO pool: the one a teacher writes straight into
 * the poll launcher and does not keep (ADR-014, addendum 2026-09-23).
 *
 * It is born PUBLISHED — version 1, no draft — because the only thing that
 * will ever read it is the poll that freezes that version, and a draft is
 * something to come back to. The configuration goes through the type's own
 * schema and its publication checks (`publishConfig`), the same gate as a
 * publication with ONE exception: the key is optional (`keyOptional`, the
 * type's `keylessConfigSchema`), for a poll may ask an opinion. A refusal is
 * `DraftInvalid` with the zod issues, for the launcher to place under its
 * fields.
 *
 * It lives HERE because `questions` and `question_versions` are this
 * module's tables. Nothing reaches it afterwards but its evaluation item: no
 * pool lists it, and `findAccessibleQuestion` joins `pools`.
 */
export async function createUnsavedQuestion(
  db: Db,
  input: { type: string; config: unknown; createdBy: string; now: Date },
): Promise<{ questionId: string; versionId: string; internalName: string }> {
  const t = typeOf(input.type);
  let config: ReturnType<typeof saveConfig>;
  try {
    config = publishConfig(input.type, input.config, { keyOptional: true });
  } catch (error) {
    throw new DraftInvalid(error instanceof NotPublishable ? error.issues : issuesOf(error));
  }
  const internalName = unsavedName(input.type, config.config);
  const questionId = randomUUID();
  const versionId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(questions).values({
      id: questionId,
      poolId: null,
      type: input.type,
      internalName,
      createdBy: input.createdBy,
      shuffleable: t.shuffleable(config.config),
      createdAt: input.now,
      updatedAt: input.now,
    });
    await tx.insert(questionVersions).values({
      id: versionId,
      questionId,
      number: 1,
      config: config.config,
      configVersion: config.configVersion,
      searchText: searchTextOf(input.type, internalName, config.config),
      publishedAt: input.now,
      publishedBy: input.createdBy,
      updatedAt: input.now,
      createdAt: input.now,
    });
  });
  return { questionId, versionId, internalName };
}

/**
 * The name of an unsaved question, and therefore the title of its poll: the
 * start of its statement, as plain text. The statement is what the room
 * reads anyway, so the title reveals nothing a participant does not see.
 */
function unsavedName(type: string, config: unknown): string {
  const prompt = (config as { prompt?: unknown }).prompt;
  const line =
    typeof prompt === "string"
      ? prompt
          .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
          .replace(/[`*_#>$\\]+/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : "";
  if (line === "") return type;
  return line.length <= 80 ? line : `${line.slice(0, 79).trimEnd()}…`;
}

/**
 * "Keep this question" (ADR-014, addenda 2026-09-23, item 6): the unsaved
 * question of a poll joins the caller's personal pool — created here on
 * first use (`ensurePersonalPool`). Nothing is copied: the question and its
 * published version already exist, and the poll that froze that version
 * keeps pointing at it. The question receives what every pool question has
 * and it lacked: a pool, a name free in that pool, and a draft to edit —
 * the published config, stamped with the publication's time so the list
 * shows no pending change.
 *
 * Idempotent: a question already in a pool — kept before, by this caller or
 * a colleague, or picked from a pool in the first place — is left alone and
 * `kept` is false. The `pool_id is null` guard on the UPDATE is what makes
 * two simultaneous keeps attach it once.
 */
export async function keepUnsavedQuestion(
  db: Db,
  input: { questionId: string; userId: string; now: Date },
): Promise<{ kept: boolean; poolId: string | null }> {
  const [question] = await db
    .select()
    .from(questions)
    .where(eq(questions.id, input.questionId))
    .limit(1);
  if (!question) throw new Error("the poll's question vanished");
  if (question.poolId !== null) return { kept: false, poolId: question.poolId };
  const pool = await ensurePersonalPool(db, input.userId);
  for (let attempt = 0; ; attempt += 1) {
    const name =
      attempt < 3
        ? await keptName(db, pool.id, question.internalName)
        : `${question.internalName} ${randomUUID().slice(0, 8)}`;
    try {
      const kept = await db.transaction(async (tx) => {
        const [attached] = await tx
          .update(questions)
          .set({ poolId: pool.id, internalName: name, updatedAt: input.now })
          .where(and(eq(questions.id, question.id), isNull(questions.poolId)))
          .returning();
        if (!attached) return false;
        const [published] = await tx
          .select()
          .from(questionVersions)
          .where(
            and(eq(questionVersions.questionId, question.id), isNotNull(questionVersions.number)),
          )
          .orderBy(desc(questionVersions.number))
          .limit(1);
        if (!published) throw new Error("an unsaved question without its published version");
        const stamp = published.publishedAt ?? published.updatedAt;
        await tx.insert(questionVersions).values({
          id: randomUUID(),
          questionId: question.id,
          number: null,
          config: published.config,
          configVersion: published.configVersion,
          explanation: published.explanation,
          searchText: searchTextOf(question.type, name, published.config),
          // Equal to the publication: `hasDraftChanges` is strict, so the
          // pool list shows the question as published and unchanged.
          updatedAt: stamp,
          createdAt: input.now,
        });
        return true;
      });
      if (kept) {
        // The pool's list and the launcher's picks; the caller's own topic
        // too, since a pool created a moment ago has no subscriber yet.
        poolChanged(pool.id);
        poolPeopleChanged([userTopic(input.userId)]);
        return { kept: true, poolId: pool.id };
      }
      // A concurrent keep won: report where it went.
      const [now] = await db
        .select({ poolId: questions.poolId })
        .from(questions)
        .where(eq(questions.id, question.id));
      return { kept: false, poolId: now?.poolId ?? null };
    } catch (error) {
      // Another question took the name between the check and the write.
      if (isUniqueViolation(error, "questions_pool_name_uq") && attempt < 3) continue;
      throw error;
    }
  }
}

/**
 * `questions_pool_name_uq` is per pool and case-insensitive. A kept question
 * is named after its statement, and two polls may well have asked the same
 * thing: the second one becomes "… (2)" rather than a 409 in the middle of a
 * lecture.
 */
async function keptName(db: Db, poolId: string, name: string): Promise<string> {
  for (let n = 1; n < 50; n += 1) {
    const candidate = n === 1 ? name : `${name} (${n})`;
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
    keyless: isKeyless(question.type, versions[0] ?? null),
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
    if (patch.categoryId !== undefined) await assertCategoryOf(tx, poolOf(question), patch.categoryId);
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
      const unique = [...new Set(patch.tags.map(normalizeTag))].filter(Boolean);
      await tx.delete(questionTags).where(eq(questionTags.questionId, question.id));
      if (unique.length) {
        await tx
          .insert(questionTags)
          .values(unique.map((tag) => ({ questionId: question.id, tag })));
        await ensurePoolTags(tx, poolOf(question), unique);
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
  }).catch((error: unknown) => {
    throw questionWriteError(error);
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
  // Writing back what is already stored is not a change (F-QST-03: "the
  // draft stays equal to the published version until the next change"). The
  // stamp stays where it was, or a no-op save right after a publication
  // would put the draft ahead of it and the question would read
  // "unpublished changes" with nothing unpublished (#72, #74).
  if (
    draft.configVersion === row.configVersion &&
    draft.explanation === explanation &&
    // Through JSON, as jsonb stores it: an `undefined` key is no difference.
    isDeepStrictEqual(draft.config, JSON.parse(JSON.stringify(row.config ?? null)))
  ) {
    return { updatedAt: draft.updatedAt.toISOString(), valid: issues.length === 0, issues };
  }
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
 * Every `asset:<uuid>` reference a stored configuration carries (F-QST-06).
 *
 * The markdown of a prompt, of a choice or of a cloze text embeds an image as
 * `asset:<uuid>`, which the web renderer rewrites into
 * `/app/api/assets/<uuid>`. Scanning the serialized config is what keeps this
 * type-agnostic: a new question type needs no hook for its images to be
 * reachable during an exam.
 */
function assetReferences(value: unknown): string[] {
  const found = new Set<string>();
  const pattern = /asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
  for (const match of JSON.stringify(value ?? null).matchAll(pattern)) {
    found.add(match[1]!.toLowerCase());
  }
  return [...found];
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
      config = publishConfig(question.type, loadConfig(question.type, draft)).config;
    } catch (error) {
      throw new DraftInvalid(error instanceof NotPublishable ? error.issues : issuesOf(error));
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

    // The link table of `db/pool.ts`: which assets this version shows. It is
    // the garbage-collection root, and it is what lets a STUDENT taking the
    // evaluation read the image (`assetReachableBy`).
    await tx
      .delete(questionVersionAssets)
      .where(eq(questionVersionAssets.versionId, draft.id));
    const referenced = assetReferences({ config, explanation: draft.explanation });
    if (referenced.length > 0) {
      // Only ids that exist: a reference to a deleted asset is a broken
      // image, not a failed publication.
      const known = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(inArray(assets.id, referenced));
      if (known.length > 0) {
        await tx
          .insert(questionVersionAssets)
          .values(known.map((row) => ({ versionId: draft.id, assetId: row.id })))
          .onConflictDoNothing();
      }
    }
    return versionJson(published!);
  });
}

/**
 * May this STUDENT read this asset? (F-QST-06, N-SEC-05.)
 *
 * Exactly when the image is shown to them by a question they are taking or
 * reviewing: a version referenced by an item of an evaluation they hold an
 * attempt on, while that attempt is running or once the results are
 * released. Anything else is a 404, indistinguishable from a missing asset
 * (invariant 6). `assets` and `question_version_assets` are this module's
 * tables; `evaluation_items` and `attempts` are read by join, never written.
 */
export async function assetReachableBy(
  db: Db,
  assetId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: questionVersionAssets.assetId })
    .from(questionVersionAssets)
    .innerJoin(
      evaluationItems,
      eq(evaluationItems.questionVersionId, questionVersionAssets.versionId),
    )
    .innerJoin(evaluations, eq(evaluations.id, evaluationItems.evaluationId))
    .innerJoin(
      attempts,
      and(eq(attempts.evaluationId, evaluationItems.evaluationId), eq(attempts.userId, userId)),
    )
    .where(
      and(
        eq(questionVersionAssets.assetId, assetId),
        or(eq(attempts.state, "in_progress"), isNotNull(evaluations.releasedAt)),
      ),
    )
    .limit(1);
  return row !== undefined;
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
 * True when ANY published version of the question is referenced (F-QST-11).
 *
 * This is what makes `409 in_use` real: a version an evaluation froze
 * (F-EVAL-03) must stay readable forever, because a student answered THAT
 * wording. `evaluation_items` belongs to the `evaluation` module; the `pool`
 * module reads it by join and never writes it (CLAUDE.md, Conventions).
 */
async function isQuestionInUse(db: Db, questionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: evaluationItems.id })
    .from(evaluationItems)
    .innerJoin(questionVersions, eq(evaluationItems.questionVersionId, questionVersions.id))
    .where(eq(questionVersions.questionId, questionId))
    .limit(1);
  return row !== undefined;
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
): Promise<QuestionRecord> {
  const draft = await draftOf(db, question.id);
  const tags = (await tagsOf(db, [question.id])).get(question.id) ?? [];
  const id = randomUUID();
  const now = new Date();
  const name = await freeName(db, input.targetPoolId, question.internalName);
  return db.transaction(async (tx) => {
    await assertCategoryOf(tx, input.targetPoolId, input.categoryId);
    const [created] = await tx.insert(questions).values({
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
    }).returning();
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
      // The copy may land in another pool, whose vocabulary learns the tags.
      await ensurePoolTags(tx, input.targetPoolId, tags);
    }
    return created!;
  }).catch((error: unknown) => {
    throw questionWriteError(error);
  });
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
