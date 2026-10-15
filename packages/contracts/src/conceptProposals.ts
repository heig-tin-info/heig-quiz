/**
 * Relations proposed to the admin on the curation screen (#897 step A,
 * ADR-114): candidates the admin may accept, one edge at a time, through the
 * relation routes of `concept.ts` (`ConceptRelationAdd`). Nothing here is
 * stored. Counts only: no question, statement, pool or person.
 */
import { z } from "zod";

/** At most this many broader candidates by label containment. */
export const CONCEPT_CONTAINMENT_MAX = 100;
/** Two concepts are proposed as related from this many shared live questions… */
export const CONCEPT_COOCCURRENCE_MIN = 3;
/** …which must be at least this share of the less-used concept's live questions. */
export const CONCEPT_COOCCURRENCE_SHARE = 0.5;
/** At most this many related candidates by co-occurrence. */
export const CONCEPT_COOCCURRENCE_MAX = 50;

/** The limits of the pre-pass, as `relationCandidatesOf` (`@quiz/domain`) takes them. */
export const CONCEPT_CANDIDATE_LIMITS = {
  containmentMax: CONCEPT_CONTAINMENT_MAX,
  min: CONCEPT_COOCCURRENCE_MIN,
  share: CONCEPT_COOCCURRENCE_SHARE,
  togetherMax: CONCEPT_COOCCURRENCE_MAX,
} as const;

/**
 * `GET /admin/concepts/relations/candidates`: the deterministic pre-pass, no
 * model, nothing stored, counts only. `contained`: `concept` would get
 * `target` as a broader concept; `together`: `a < b` would be related, being
 * on `questions` live questions together.
 */
export const ConceptRelationCandidates = z.object({
  contained: z.array(z.object({ concept: z.uuid(), target: z.uuid() })).max(CONCEPT_CONTAINMENT_MAX),
  together: z
    .array(z.object({ a: z.uuid(), b: z.uuid(), questions: z.number().int().min(CONCEPT_COOCCURRENCE_MIN) }))
    .max(CONCEPT_COOCCURRENCE_MAX),
});
export type ConceptRelationCandidates = z.infer<typeof ConceptRelationCandidates>;

// The model's pass (#897 step A2) adds `ConceptRelationProposals` here.
