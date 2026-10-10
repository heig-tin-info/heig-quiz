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
 * recomputes them by a migration. Aliases (ADR-081 §6) come with the
 * admin's curation, not in this step.
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { CONCEPT_STATUSES, TAG_DROP_REASONS, TAG_SORTING_DECISIONS } from "@quiz/contracts";

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
 * The sorting of the existing tags (ADR-081, second addendum 2026-10-08 §1):
 * one row per (pool, tag), so a homonym can go to two concepts. FROZEN since
 * step (d): the sorting workflow is retired and `question_tags` / `pool_tags`
 * are dropped, nothing writes this table. The `drop` rows are still read —
 * they are the stop list of `concept_dropped` (third addendum §4) — and
 * `concept_id` restricts the deletion of a concept a decision maps to.
 *
 * A row is accepted exactly when it has a decision, and is otherwise the
 * model's proposal alone. The checks keep it so: a
 * decision is taken at an instant, a row without one holds a proposal and
 * nobody's decision, a `concept` decision names its concept and no reason, a
 * `drop` names its reason and no concept. `concept_id` restricts deletion:
 * a concept a decision maps to cannot vanish under it.
 */
export const conceptTagSortings = pgTable(
  "concept_tag_sortings",
  {
    poolId: uuid("pool_id")
      .notNull()
      .references(() => pools.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    decision: text("decision", { enum: TAG_SORTING_DECISIONS }),
    conceptId: uuid("concept_id").references(() => concepts.id),
    dropReason: text("drop_reason", { enum: TAG_DROP_REASONS }),
    /** The model's raw answer for the pair; null when the admin decided without one. */
    proposal: jsonb("proposal"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.poolId, t.tag] }),
    // A decision is taken at an instant; without one, the row is the model's proposal and nobody's decision.
    check(
      "concept_tag_sortings_decided_ck",
      sql`(${t.decision} is null) = (${t.decidedAt} is null)
        and (${t.decision} is not null or (${t.proposal} is not null and ${t.decidedBy} is null))`,
    ),
    // A decision carries exactly what it needs: its concept, or its reason.
    check(
      "concept_tag_sortings_decision_ck",
      sql`(${t.conceptId} is not null) = (${t.decision} is not distinct from 'concept')
        and (${t.dropReason} is not null) = (${t.decision} is not distinct from 'drop')`,
    ),
    index("concept_tag_sortings_concept_idx").on(t.conceptId),
  ],
);

/**
 * The model pass that proposed the sorting (second addendum §3), RETIRED
 * with the sorting workflow (step (d)): nothing reads or writes it; its table
 * is dropped by a later migration. It had ONE row
 * (`id = 'default'`), the last run. A run is started by claiming the row:
 * one conditional upsert that succeeds only when no run is `running`, or
 * when the running one's heartbeat went silent — its process died — so a
 * crash never blocks the next start. `started_at` is the run's lease: the
 * job carries it and writes only while it is still the row's. The
 * heartbeat moves at every batch.
 */
export const conceptSortRuns = pgTable(
  "concept_sort_runs",
  {
    id: text("id").primaryKey().default("default"),
    state: text("state").notNull(),
    /** The admin who started it, billed for its calls; null once their account is gone. */
    startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    groupsDone: integer("groups_done").notNull().default(0),
    groupsTotal: integer("groups_total").notNull().default(0),
    /** Batches whose call failed without stopping the run: their pairs kept what they had. */
    batchesFailed: integer("batches_failed").notNull().default(0),
    error: text("error"),
  },
  (t) => [
    check("concept_sort_runs_singleton", sql`${t.id} = 'default'`),
    check("concept_sort_runs_finished_ck", sql`(${t.state} = 'running') = (${t.finishedAt} is null)`),
    check("concept_sort_runs_error_ck", sql`(${t.state} = 'failed') = (${t.error} is not null)`),
  ],
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
