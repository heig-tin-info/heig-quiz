/**
 * Relations proposed to the admin on the curation screen (#897 step A,
 * ADR-114): candidates the admin may accept, one edge at a time, through the
 * relation route of `concept.ts` (`ConceptRelationAdd`). Nothing here is
 * stored. Counts only: no question, statement, pool or person.
 */
import { z } from "zod";

import { RELATION_CANDIDATE_LIMITS } from "@quiz/domain";

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
