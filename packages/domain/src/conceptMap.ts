/**
 * The concept map of a pool (ADR-116 §1): pure rules, no database. From the
 * links between the pool's live questions and their concepts, and the
 * vocabulary's `broader` edges, it computes what the pool's Concepts tab
 * counts and draws.
 *
 * - L, the linked concepts: those linked to at least one question;
 *   Q(c), the questions linked to c.
 * - R, the pool's reach: L plus every broader concept above a member of L,
 *   near or far, through `broader` edges only (`related` never). R is closed
 *   upwards.
 * - covered(r): the questions linked to r or to any narrower concept, counted
 *   once — what a click on r opens (the pool's filter, ADR-081 §4).
 * - own(r): the questions linked to r and to none of its narrower concepts;
 *   own > 0 only for a member of L.
 *
 * The covered questions of r are its own ones and the covered questions of
 * its direct narrower concepts; the sum of the parts may exceed covered(r)
 * (a question linked to two siblings counts in both), which is why the map
 * shows one level per view.
 */
import { broaderAncestorsOf, coverageOf, type RelationEdge } from "./conceptRelations.js";

/** A question linked to a concept. */
export interface ConceptLink {
  question: string;
  concept: string;
}

/** A concept of the reach, counted. */
export interface ConceptMapNode {
  id: string;
  /** The questions linked to it or to a narrower concept, once each. */
  covered: number;
  /** The questions linked to it and to none of its narrower concepts. */
  own: number;
  /** Whether a question is linked to it directly (a member of L). */
  linked: boolean;
}

export interface ConceptMap {
  /** Every concept of the reach, by id. */
  nodes: ConceptMapNode[];
  /** The `broader` edges among the reach, sorted by concept then target. */
  broader: RelationEdge[];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The map of the concepts the given links reach (ADR-116 §1). */
export function conceptMap(links: readonly ConceptLink[], broader: readonly RelationEdge[]): ConceptMap {
  const questionsOf = new Map<string, Set<string>>();
  for (const l of links) {
    if (!questionsOf.has(l.concept)) questionsOf.set(l.concept, new Set());
    questionsOf.get(l.concept)!.add(l.question);
  }
  const linked = [...questionsOf.keys()];
  const ancestors = [...broaderAncestorsOf(broader, linked).values()].flat();
  const reach = [...new Set([...linked, ...ancestors])].sort();
  const cover = coverageOf(broader, reach);
  const union = (ids: readonly string[]) => new Set(ids.flatMap((c) => [...(questionsOf.get(c) ?? [])]));
  const nodes = reach.map((id): ConceptMapNode => {
    const [, ...narrower] = cover.get(id)!;
    const below = union(narrower);
    const own = [...(questionsOf.get(id) ?? [])].filter((q) => !below.has(q)).length;
    // Its own questions are exactly those it adds to what its narrower concepts cover.
    return { id, covered: below.size + own, own, linked: questionsOf.has(id) };
  });
  const inReach = new Set(reach);
  const edges = broader
    .filter((e) => inReach.has(e.concept) && inReach.has(e.target))
    .sort((a, b) => compare(a.concept, b.concept) || compare(a.target, b.target));
  return { nodes, broader: edges };
}
