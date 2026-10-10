/**
 * The curated aliases of a concept (ADR-081 §6, fifth addendum), the admin's:
 * other names a concept answers to, with no language, stored as their
 * `conceptKey` plus the text as written. A typed input that is no label and
 * no id resolves through them (`resolveConceptLabel`), so a question only
 * ever stores the concept id; an alias never becomes a label.
 *
 * An alias that would make an input ambiguous for every teacher — its key is
 * the label or an alias of ANOTHER concept — is refused with a 409
 * `alias_collision` naming those concepts, and stored only when the admin
 * resends it with `force`. An alias equal to the concept's own label (or
 * alias) is pointless: 422 `alias_redundant` / 409 `alias_exists`. The stop
 * list is not consulted: an alias is a curated decision, and an input that
 * resolves is never `concept_dropped` (that outcome belongs to an input that
 * designates nothing).
 */
import { and, eq } from "drizzle-orm";

import type { AliasCollision, Concept, ConceptAliasAdd, ConceptLang } from "@quiz/contracts";
import { checkAlias, conceptKey } from "@quiz/domain";

import { audit } from "../../audit.js";
import type { Db, Tx } from "../../db/client.js";
import { conceptAliases, concepts } from "../../db/schema.js";
import { DomainError, notFoundError } from "../http.js";
import { loadAliases, toConcept, toConceptRef, toResolvable } from "./row.js";
import type { ConceptContext } from "./service.js";

type AliasContext = Omit<ConceptContext, "caller"> & { userId: string | null; lang: ConceptLang };

async function lockLive(tx: Db | Tx, id: string) {
  const [row] = await tx.select().from(concepts).where(eq(concepts.id, id)).for("update");
  if (!row) throw notFoundError("concept");
  if (row.status === "merged") throw new DomainError("concept_merged", 409, "A merged concept has no aliases");
  return row;
}

export async function addAlias(db: Db, ctx: AliasContext, id: string, body: ConceptAliasAdd): Promise<Concept> {
  const text = body.alias.replace(/\s+/g, " ");
  const key = conceptKey(text);
  return db.transaction(async (tx) => {
    const row = await lockLive(tx, id);
    const rows = await tx.select().from(concepts);
    const aliases = await loadAliases(tx);
    const vocabulary = rows.map((r) => toResolvable(r, aliases.get(r.id)));
    const check = checkAlias(text, vocabulary.find((c) => c.id === id)!, vocabulary);
    if (check.kind === "redundant") {
      throw check.of === "label"
        ? new DomainError("alias_redundant", 422, "An alias equal to the concept's own label is pointless")
        : new DomainError("alias_exists", 409, "The concept already has this alias");
    }
    const collisions =
      check.kind === "collides"
        ? check.with.map((hit) => ({ concept: toConceptRef(rows.find((r) => r.id === hit.id)!, ctx.lang), via: hit.via }))
        : [];
    if (collisions.length > 0 && !body.force) {
      throw new DomainError("alias_collision", 409, "This alias would make an input ambiguous", {
        collisions,
      } satisfies Omit<AliasCollision, "error" | "message">);
    }
    await tx.insert(conceptAliases).values({ conceptId: id, key, text, createdBy: ctx.userId, createdAt: ctx.now });
    await audit(tx, {
      ...ctx.actor,
      action: "concept.alias_add",
      subjectType: "concept",
      subjectId: id,
      payload: { alias: text, forced: collisions.length > 0, collidesWith: collisions.map((c) => c.concept.id).sort() },
    });
    return toConcept(row, (await loadAliases(tx, [id])).get(id));
  });
}

export async function removeAlias(db: Db, ctx: Omit<ConceptContext, "caller">, id: string, key: string): Promise<Concept> {
  return db.transaction(async (tx) => {
    const row = await lockLive(tx, id);
    const [gone] = await tx
      .delete(conceptAliases)
      .where(and(eq(conceptAliases.conceptId, id), eq(conceptAliases.key, key)))
      .returning();
    if (!gone) throw notFoundError("alias");
    await audit(tx, {
      ...ctx.actor,
      action: "concept.alias_remove",
      subjectType: "concept",
      subjectId: id,
      payload: { alias: gone.text },
    });
    return toConcept(row, (await loadAliases(tx, [id])).get(id));
  });
}
