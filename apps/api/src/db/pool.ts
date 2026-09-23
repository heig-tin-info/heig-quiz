/**
 * Question pools: pools, categories, questions, their versions and the
 * assets they embed (PLAN-MVP §3.2). Owned by the `pool` module.
 *
 * Two invariants live in the indexes rather than in the service, because
 * only the database can enforce them under concurrency:
 *   - `question_versions_draft_uq`: AT MOST ONE draft per question
 *     (`number is null`), so two simultaneous publications cannot both
 *     recreate the draft — one loses with a unique violation;
 *   - `question_versions_question_number_uq`: version numbers are dense and
 *     unique, so `max(number) + 1` can never be handed out twice.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { courses } from "./org.js";

/**
 * Postgres `tsvector`. Drizzle has no column type for it; the value is never
 * read or written from TypeScript (the column is GENERATED), so the data
 * type is only there for the migration and for the GIN index.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

/** A named set of questions. `is_personal` marks the one pool created with an account. */
export const pools = pgTable(
  "pools",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    /** A lucide icon name (`cpu`, `flask-conical`); null shows the default. */
    icon: text("icon"),
    visibility: text("visibility", { enum: ["private", "shared", "public"] })
      .notNull()
      .default("private"),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    isPersonal: boolean("is_personal").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pools_owner_idx").on(t.ownerId),
    uniqueIndex("pools_personal_uq").on(t.ownerId).where(sql`${t.isPersonal}`),
  ],
);

/**
 * Explicit sharing of a pool with another account (F-POOL-05): the members
 * the owner named, with what each may do. `poolAccess` reads it, the member
 * routes of the `pool` module write it.
 *
 * `created_at` is load-bearing: it is the succession order when the owner
 * loses the teacher role (`transferOnLoss`), so the FIRST member invited is
 * the one who inherits the pool.
 *
 * The `pools.owner_id` account is never a row here — it is the owner by
 * definition. A member MAY hold the `owner` role, which grants everything
 * except being the fallback of the succession.
 */
export const poolMembers = pgTable(
  "pool_members",
  {
    poolId: uuid("pool_id")
      .notNull()
      .references(() => pools.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["reader", "contributor", "owner"] })
      .notNull()
      .default("reader"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.poolId, t.userId] }), index("pool_members_user_idx").on(t.userId)],
);

/**
 * The pools a course draws its questions from. This is the SECOND way a pool
 * is reachable (`poolAccess`, after `pool_members`): the whole teaching staff
 * of the course works in it, so the `org` module goes through
 * `pool/service.ts` to write it.
 */
export const coursePools = pgTable(
  "course_pools",
  {
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => pools.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.courseId, t.poolId] }),
    index("course_pools_pool_idx").on(t.poolId),
  ],
);

/** Folder of a pool. A null parent is a root folder; `position` orders siblings. */
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey(),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => pools.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Self-reference: deleting a folder deletes its subtree, and the
    // questions it held fall back to the pool root (`set null` above).
    foreignKey({ columns: [t.parentId], foreignColumns: [t.id], name: "categories_parent_fk" })
      .onDelete("cascade"),
    index("categories_pool_idx").on(t.poolId, t.parentId, t.position),
  ],
);

/**
 * A question: its identity and metadata. The content lives in
 * `question_versions` — never here — so that an evaluation can freeze the
 * exact wording a student saw (F-EVAL-03).
 *
 * `pool_id` is null for exactly one kind of question: the one a teacher
 * writes straight into the poll launcher and never saves (ADR-014,
 * addendum 2026-09-23). It exists only as the frozen version its poll runs;
 * no pool lists it, and `findAccessibleQuestion` — which joins `pools` —
 * never reaches it, so nobody can open it in the editor.
 */
export const questions = pgTable(
  "questions",
  {
    id: uuid("id").primaryKey(),
    poolId: uuid("pool_id").references(() => pools.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    /** Registered question-type id (`mcq`, `short`, `cloze`, `code`). */
    type: text("type").notNull(),
    /** Teacher-facing name; never shown to a student (invariant 4). */
    internalName: text("internal_name").notNull(),
    difficulty: smallint("difficulty").notNull().default(2),
    shuffleable: boolean("shuffleable").notNull().default(true),
    randomizable: boolean("randomizable").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id),
    /** Set when the question was copied from another one (`POST /copy`). */
    originQuestionId: uuid("origin_question_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("questions_difficulty_check", sql`${t.difficulty} between 1 and 5`),
    // Provenance of a copy: kept, but a deleted original must not delete the
    // copy — the copy is a full, independent question.
    foreignKey({
      columns: [t.originQuestionId],
      foreignColumns: [t.id],
      name: "questions_origin_fk",
    }).onDelete("set null"),
    uniqueIndex("questions_pool_name_uq")
      .on(t.poolId, sql`lower(${t.internalName})`)
      .where(sql`${t.deletedAt} is null`),
    index("questions_pool_type_idx").on(t.poolId, t.type),
    index("questions_category_idx").on(t.categoryId),
  ],
);

/**
 * The tag vocabulary of a pool: one row per distinct tag, with the optional
 * one-line description a teacher writes for it. A row is created LAZILY by
 * `patchQuestion`/`copyQuestion` when a question receives a tag the pool has
 * never seen, so `question_tags` stays the source of truth for usage and this
 * table only carries the documentation.
 */
export const poolTags = pgTable(
  "pool_tags",
  {
    poolId: uuid("pool_id")
      .notNull()
      .references(() => pools.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.poolId, t.tag] })],
);

export const questionTags = pgTable(
  "question_tags",
  {
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
  },
  (t) => [primaryKey({ columns: [t.questionId, t.tag] }), index("question_tags_tag_idx").on(t.tag)],
);

/**
 * One row per version of a question, plus exactly one draft (`number is
 * null`). Publishing turns the draft into version `max + 1` and opens a new
 * draft with the same content, in one transaction.
 *
 * `search_text` is filled by the service (`type.searchText(config)` plus the
 * internal name — Postgres cannot call TypeScript), and `search` is derived
 * from it by the database so the two can never drift.
 */
export const questionVersions = pgTable(
  "question_versions",
  {
    id: uuid("id").primaryKey(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    /** null = the draft. */
    number: integer("number"),
    config: jsonb("config").notNull(),
    configVersion: integer("config_version").notNull().default(1),
    explanation: text("explanation").notNull().default(""),
    searchText: text("search_text").notNull().default(""),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('simple', search_text)`,
    ),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by").references(() => users.id),
    changeNote: text("change_note"),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
    deprecationNote: text("deprecation_note"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("question_versions_question_number_uq").on(t.questionId, t.number),
    uniqueIndex("question_versions_draft_uq")
      .on(t.questionId)
      .where(sql`${t.number} is null`),
    index("question_versions_search_idx").using("gin", t.search),
  ],
);

/**
 * An uploaded image, deduplicated by content hash: the same picture pasted
 * in ten questions is stored once. `path` is relative to `ASSETS_DIR`.
 */
export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    poolId: uuid("pool_id").references(() => pools.id, { onDelete: "set null" }),
    sha256: text("sha256").notNull().unique(),
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    path: text("path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("assets_pool_idx").on(t.poolId)],
);

/**
 * Which assets a published version references — the garbage-collection root.
 * TODO(WP7): filled at publication by scanning the markdown of the config for
 * `asset:<uuid>` references. Nothing writes it in the MVP, and nothing
 * collects garbage yet either.
 */
export const questionVersionAssets = pgTable(
  "question_version_assets",
  {
    versionId: uuid("version_id")
      .notNull()
      .references(() => questionVersions.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.assetId] }),
    index("question_version_assets_asset_idx").on(t.assetId),
  ],
);
