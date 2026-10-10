/**
 * Concept seeding for the database tests: a row of the vocabulary inserted
 * straight, with the keys the service would compute, so a test starts from
 * any state (a merged concept, one language only) without going through the
 * routes.
 */
import { randomUUID } from "node:crypto";

import { qualifiedConceptKey } from "@quiz/domain";

import type { Db } from "../db/client.js";
import { concepts } from "../db/schema.js";

/** One language of a concept: its label and, optionally, its qualifier. */
export type ConceptSide = [label: string, qualifier?: string] | null;

/** Inserts a concept (validated by default) and answers its id. */
export async function seedConcept(
  db: Db,
  createdBy: string,
  fr: ConceptSide,
  en: ConceptSide = null,
  status: "proposed" | "validated" | "merged" = "validated",
  mergedInto: string | null = null,
  extra: { createdAt?: Date; description?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const side = (s: ConceptSide) => ({ label: s?.[0] ?? null, qualifier: s?.[1] ?? "" });
  const f = side(fr);
  const e = side(en);
  await db.insert(concepts).values({
    id,
    status,
    mergedInto,
    createdBy,
    labelFr: f.label,
    qualifierFr: f.qualifier,
    keyFr: f.label === null ? null : qualifiedConceptKey(f.label, f.qualifier),
    labelEn: e.label,
    qualifierEn: e.qualifier,
    keyEn: e.label === null ? null : qualifiedConceptKey(e.label, e.qualifier),
    ...(extra.createdAt ? { createdAt: extra.createdAt } : {}),
    ...(extra.description ? { descriptionFr: extra.description, descriptionEn: extra.description } : {}),
  });
  return id;
}
