/**
 * The vocabulary of concepts (ADR-081, addendum 2026-10-08): one for the
 * whole instance, owned by the `concept` module, with its links to
 * questions (the free tags they replaced are gone, step (d)).
 *
 * Uniqueness lives in the indexes, because only the database can enforce it
 * under concurrency (addendum §3): two teachers creating `pointeur` and
 * `Pointeurs` at the same time cannot both succeed. `key_fr`/`key_en` are
 * `qualifiedConceptKey` (`@quiz/domain`) of the label and qualifier, computed
 * by the service on every write; they serve this index only (the resolver
 * computes its keys from the labels), and a change of the key rule
 * recomputes them by a migration. Aliases (ADR-081 §6) are `concept_aliases`
 * below.
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { CONCEPT_STATUSES, TAG_DROP_REASONS } from "@quiz/contracts";

import { users } from "./auth.js";
import { pools, questions } from "./pool.js";

/**
 * A concept: a label, a qualifier and a description per language. A
 * `proposed` concept may have one language only. A merged concept is kept,
 * `merged_into` naming the final concept, so an old id still resolves; it
 * leaves the unique indexes, so its label may be taken again.
 */
export const concepts = pgTable(
  "concepts",
  {
    id: uuid("id").primaryKey(),
    status: text("status", { enum: CONCEPT_STATUSES }).notNull().default("proposed"),
    mergedInto: uuid("merged_into"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    labelFr: text("label_fr"),
    labelEn: text("label_en"),
    qualifierFr: text("qualifier_fr").notNull().default(""),
    qualifierEn: text("qualifier_en").notNull().default(""),
    descriptionFr: text("description_fr").notNull().default(""),
    descriptionEn: text("description_en").notNull().default(""),
    keyFr: text("key_fr"),
    keyEn: text("key_en"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.mergedInto], foreignColumns: [t.id], name: "concepts_merged_into_fk" }),
    // One source for "merged": the status and `merged_into` agree, and a concept is never merged into itself.
    check(
      "concepts_merged_ck",
      sql`(${t.status} = 'merged') = (${t.mergedInto} is not null) and ${t.mergedInto} is distinct from ${t.id}`,
    ),
    check("concepts_label_ck", sql`${t.labelFr} is not null or ${t.labelEn} is not null`),
    uniqueIndex("concepts_key_fr_uq")
      .on(t.keyFr)
      .where(sql`${t.status} <> 'merged' and ${t.keyFr} is not null`),
    uniqueIndex("concepts_key_en_uq")
      .on(t.keyEn)
      .where(sql`${t.status} <> 'merged' and ${t.keyEn} is not null`),
  ],
);

/**
 * The stop list of `concept_dropped` (ADR-081, third addendum §4): one row
 * per (pool, tag) the admin dropped in the former tag sorting, with its
 * reason. Since step (d) (fourth addendum) the sorting workflow is retired
 * and nothing writes the table; a pool's rows go with the pool. Every row is
 * a drop, so the table keeps no decision, concept, proposal or author: only
 * the tag, its reason and when it was dropped.
 */
export const conceptTagSortings = pgTable(
  "concept_tag_sortings",
  {
    poolId: uuid("pool_id")
      .notNull()
      .references(() => pools.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    dropReason: text("drop_reason", { enum: TAG_DROP_REASONS }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.poolId, t.tag] })],
);

/**
 * The concepts a question exercises (ADR-081 §2, third addendum §1), owned
 * by the `concept` module (addendum §4): the pool module sets them by
 * calling the concept service inside its own transaction and reads them by
 * join. A question's links go with the question; a concept a question uses
 * cannot be deleted (RESTRICT: it is merged, never deleted, third addendum
 * §7). No order: "a question's first concept" is the smallest id.
 */
export const questionConcepts = pgTable(
  "question_concepts",
  {
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.questionId, t.conceptId] }), index("question_concepts_concept_idx").on(t.conceptId)],
);

/**
 * The curated aliases of a concept (ADR-081 §6, fifth addendum): other names
 * it answers to, added by the admin only, with no language. `key` is the
 * `conceptKey` of `text`, computed by the service; the primary key is
 * (concept, key), so a concept holds a key once, while another concept MAY
 * hold the same key (a forced collision: the input is then ambiguous). They
 * go with their concept (cascade) and are not references: they never block
 * its deletion.
 */
export const conceptAliases = pgTable(
  "concept_aliases",
  {
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    text: text("text").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conceptId, t.key] }), index("concept_aliases_key_idx").on(t.key)],
);
