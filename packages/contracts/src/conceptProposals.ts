/**
 * Relations proposed to the admin on the curation screen (#897 step A,
 * ADR-114): candidates the admin may accept, one edge at a time, through the
 * relation route of `concept.ts` (`ConceptRelationAdd`). Nothing here is
 * stored. Counts only: no question, statement, pool or person.
 */
import { z } from "zod";

import { RELATION_CANDIDATE_LIMITS } from "@quiz/domain";

import { CONCEPT_AI_REASON_MAX, ConceptLang, NewConceptName } from "./concept.js";

/**
 * One candidate edge: `broader` reads "`concept` would get `target` as a
 * broader concept" (found by label containment); `related` pairs
 * `concept < target`, on `questions` live questions together.
 */
export const ConceptRelationCandidate = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("broader"), concept: z.uuid(), target: z.uuid(), questions: z.null() }),
  z.object({
    kind: z.literal("related"),
    concept: z.uuid(),
    target: z.uuid(),
    questions: z.number().int().min(RELATION_CANDIDATE_LIMITS.min),
  }),
]);
export type ConceptRelationCandidate = z.infer<typeof ConceptRelationCandidate>;

/** `GET /admin/concepts/relations/candidates`: the deterministic pre-pass, no model, broader ones first. */
export const ConceptRelationCandidates = z.object({
  candidates: z
    .array(ConceptRelationCandidate)
    .max(RELATION_CANDIDATE_LIMITS.contained + RELATION_CANDIDATE_LIMITS.together),
});
export type ConceptRelationCandidates = z.infer<typeof ConceptRelationCandidates>;

/**
 * The model's pass (ADR-114 §2): at most `PLACE` concepts to place per call,
 * and the caps of its answer — broader edges, related pairs, missing top
 * concepts and the concepts each top gathers.
 */
export const CONCEPT_PROPOSE_PLACE_MAX = 40;
export const CONCEPT_PROPOSE_BROADER_MAX = 80;
export const CONCEPT_PROPOSE_RELATED_MAX = 30;
export const CONCEPT_PROPOSE_TOPS_MAX = 10;
export const CONCEPT_PROPOSE_TOP_NARROWER_MAX = 15;
export const CONCEPT_PROPOSE_EXCLUDE_MAX = 400;

/**
 * `POST /admin/concepts/relations/ai`: the one concept to place (the sheet's
 * Suggest a broader concept); without it, the oldest
 * {@link CONCEPT_PROPOSE_PLACE_MAX} Unplaced concepts not in `exclude` — the
 * ones the page asked about already, so that Ask again moves on.
 */
export const ConceptRelationsAiRequest = z
  .object({ concept: z.uuid().optional(), exclude: z.array(z.uuid()).max(CONCEPT_PROPOSE_EXCLUDE_MAX).optional() })
  .strict();
export type ConceptRelationsAiRequest = z.infer<typeof ConceptRelationsAiRequest>;

/**
 * The model's proposals, validated by the server against the graph, nothing
 * stored. `broader` reads "`concept` would get `target` as a broader
 * concept"; a `related` pair carries the model's reason; a top is a concept
 * the vocabulary lacks, named in `lang` (the admin's), that would gather
 * `narrower`, created `proposed` only when the admin accepts a row of it.
 * `asked`: the concepts this call asked a place for; `remaining`: the
 * Unplaced concepts neither asked about nor excluded; `truncated`: the
 * vocabulary was longer than a call takes.
 */
export const ConceptRelationProposals = z.object({
  lang: ConceptLang,
  asked: z.array(z.uuid()).max(CONCEPT_PROPOSE_PLACE_MAX),
  broader: z.array(z.object({ concept: z.uuid(), target: z.uuid() })).max(CONCEPT_PROPOSE_BROADER_MAX),
  related: z
    .array(z.object({ a: z.uuid(), b: z.uuid(), reason: z.string().min(1).max(CONCEPT_AI_REASON_MAX) }))
    .max(CONCEPT_PROPOSE_RELATED_MAX),
  tops: z
    .array(
      NewConceptName.extend({
        reason: z.string().min(1).max(CONCEPT_AI_REASON_MAX),
        narrower: z.array(z.uuid()).min(2).max(CONCEPT_PROPOSE_TOP_NARROWER_MAX),
      }),
    )
    .max(CONCEPT_PROPOSE_TOPS_MAX),
  remaining: z.number().int().min(0),
  truncated: z.boolean(),
});
export type ConceptRelationProposals = z.infer<typeof ConceptRelationProposals>;
