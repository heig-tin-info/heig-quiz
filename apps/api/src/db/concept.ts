/**
 * The vocabulary of concepts (ADR-081, addendum 2026-10-08): one for the
 * whole instance, owned by the `concept` module. Nothing links to it yet
 * (addendum §1a): the tags of the `pool` module stay the source of truth
 * until the cut-over.
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
import { check, foreignKey, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { CONCEPT_STATUSES } from "@quiz/contracts";

import { users } from "./auth.js";

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
