/**
 * Relations between concepts (ADR-081 §4, sixth addendum, step 7c): pure
 * rules, no database. Two kinds of edge:
 *
 * - `broader`: `{ concept, target }` reads "`concept` has `target` as a
 *   broader concept". A concept may have several (a poly-hierarchy); the
 *   edges form a DAG, never a cycle.
 * - `related`: symmetric, stored once in canonical order (`concept < target`,
 *   see {@link canonicalRelated}).
 *
 * A path is a list of concept ids. The rules take plain edges, so the
 * service builds them from the table and the client from `Concept.broader`.
 */

export interface RelationEdge {
  concept: string;
  target: string;
}

/** Every edge of the vocabulary, by kind. */
export interface RelationEdges {
  broader: readonly RelationEdge[];
  related: readonly RelationEdge[];
}

/** A concept as the relation helpers read it: its id and its direct relations (`Concept` has them). */
export interface RelatedConcept {
  id: string;
  broader: readonly string[];
  related: readonly string[];
}

/** Every edge of a list of concepts; a related pair, listed on both sides, once in canonical order. */
export function edgesOf(concepts: readonly RelatedConcept[]): RelationEdges {
  const related = new Map<string, RelationEdge>();
  for (const c of concepts) {
    for (const other of c.related) {
      const edge = canonicalRelated(c.id, other);
      related.set(`${edge.concept}\u0000${edge.target}`, edge);
    }
  }
  return {
    broader: concepts.flatMap((c) => c.broader.map((target) => ({ concept: c.id, target }))),
    related: [...related.values()],
  };
}

/**
 * The concepts placed nowhere in the hierarchy (#897): no broader concept and
 * no narrower one (no concept lists them in its `broader`); `related` does
 * not place a concept. A root with children is placed. One pass over the
 * `broader` lists, in the order given.
 */
export function unplaced<C extends Pick<RelatedConcept, "id" | "broader">>(concepts: readonly C[]): C[] {
  const placed = new Set<string>();
  for (const c of concepts) {
    if (c.broader.length === 0) continue;
    placed.add(c.id);
    for (const id of c.broader) placed.add(id);
  }
  return concepts.filter((c) => !placed.has(c.id));
}

/**
 * The concepts directly under `id` (#897): those that list it in their
 * `broader`, in the order given; not the narrower ones further down
 * ({@link narrowerDescendants}). The edge belongs to the child.
 */
export function directNarrowerOf<C extends Pick<RelatedConcept, "id" | "broader">>(concepts: readonly C[], id: string): C[] {
  return concepts.filter((c) => c.broader.includes(id));
}

/** The direct relations of every concept named by `edges`, sorted (a related pair on both sides); the inverse of {@link edgesOf}. */
export function relationsOf(edges: RelationEdges): Map<string, { broader: string[]; related: string[] }> {
  const out = new Map<string, { broader: string[]; related: string[] }>();
  const of = (id: string) => out.get(id) ?? out.set(id, { broader: [], related: [] }).get(id)!;
  for (const e of edges.broader) of(e.concept).broader.push(e.target);
  for (const e of edges.related) {
    of(e.concept).related.push(e.target);
    of(e.target).related.push(e.concept);
  }
  for (const r of out.values()) {
    r.broader.sort();
    r.related.sort();
  }
  return out;
}

/** The two ids in the order a `related` edge is stored: smaller id first. */
export function canonicalRelated(a: string, b: string): RelationEdge {
  return a < b ? { concept: a, target: b } : { concept: b, target: a };
}

/** The adjacency of the broader graph: upwards (concept to its broader) or downwards. */
function adjacency(edges: readonly RelationEdge[], up: boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const [from, to] = up ? [e.concept, e.target] : [e.target, e.concept];
    out.set(from, [...(out.get(from) ?? []), to]);
  }
  return out;
}

/**
 * Breadth-first walk from `start`: each reached concept with the one it was
 * reached from. `start` is in the map only when a cycle leads back to it.
 */
function reach(next: ReadonlyMap<string, readonly string[]>, start: string): Map<string, string> {
  const from = new Map<string, string>();
  const queue = [start];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const to of next.get(at) ?? []) {
      if (from.has(to)) continue;
      from.set(to, at);
      queue.push(to);
    }
  }
  return from;
}

/** Every narrower concept of `id`, near or far, sorted: what a selected concept covers (§4). */
export function narrowerDescendants(broader: readonly RelationEdge[], id: string): string[] {
  return narrowerDescendantsOf(broader, [id]).get(id)!;
}

/** Every concept reached from each of `ids` upwards or downwards, near or far, itself excluded, sorted; the adjacency built once. */
function closureOf(broader: readonly RelationEdge[], ids: readonly string[], up: boolean): Map<string, string[]> {
  const next = adjacency(broader, up);
  return new Map(ids.map((id) => [id, [...reach(next, id).keys()].filter((c) => c !== id).sort()]));
}

/** {@link narrowerDescendants} of several concepts, the downward adjacency built once. */
export function narrowerDescendantsOf(broader: readonly RelationEdge[], ids: readonly string[]): Map<string, string[]> {
  return closureOf(broader, ids, false);
}

/** Every broader concept of each of `ids`, near or far, sorted: the mirror of {@link narrowerDescendantsOf}. */
export function broaderAncestorsOf(broader: readonly RelationEdge[], ids: readonly string[]): Map<string, string[]> {
  return closureOf(broader, ids, true);
}

/**
 * COVERAGE (ADR-081 §4, sixth addendum §10): for each of `ids`, the concepts
 * it covers, itself first and then every narrower one, near or far. Only
 * `broader` edges widen it; a `related` concept is never covered.
 */
export function coverageOf(broader: readonly RelationEdge[], ids: readonly string[]): Map<string, string[]> {
  const narrower = narrowerDescendantsOf(broader, ids);
  return new Map(ids.map((id) => [id, [id, ...narrower.get(id)!]]));
}

/**
 * The shortest chain of broader concepts from `from` up to `to` (both
 * included), or null when `to` is not above `from`. With `from === to` it
 * is the shortest cycle through `from`, if any.
 */
export function broaderPath(broader: readonly RelationEdge[], from: string, to: string): string[] | null {
  const came = reach(adjacency(broader, true), from);
  if (!came.has(to)) return null;
  const path = [to];
  for (let at = came.get(to)!; ; at = came.get(at)!) {
    path.unshift(at);
    if (at === from) return path;
  }
}

/** Why an edge cannot be added. `cycle` names the closed path (first and last id equal). */
export type RelationRefusal =
  | { kind: "self" }
  | { kind: "exists" }
  | { kind: "cycle"; path: string[] }
  | { kind: "redundant" };

/**
 * Whether `concept` may get `target` as a broader concept. Refused when it
 * is the same concept (`self`), when the edge exists (`exists`), when
 * `concept` is `target` or above it, which would close a cycle (`cycle`:
 * the path is `concept`, `target`, … back to `concept`), and when the two
 * are `related` already (`redundant`: the two relations are disjoint, as in
 * SKOS). Only the direct pair is checked: a related pair that a later broader
 * edge puts in one chain stays, harmlessly.
 */
export function checkBroaderEdge(edges: RelationEdges, concept: string, target: string): RelationRefusal | null {
  if (concept === target) return { kind: "self" };
  if (edges.broader.some((e) => e.concept === concept && e.target === target)) return { kind: "exists" };
  const up = broaderPath(edges.broader, target, concept);
  if (up) return { kind: "cycle", path: [concept, ...up] };
  const pair = canonicalRelated(concept, target);
  if (edges.related.some((e) => e.concept === pair.concept && e.target === pair.target)) return { kind: "redundant" };
  return null;
}

/**
 * Whether `a` and `b` may be related. Refused for the same concept (`self`),
 * an existing edge in either order (`exists`), and two concepts one of which
 * is in the other's broader chain, near or far (`redundant`: a hierarchy
 * already says more than "related").
 */
export function checkRelatedEdge(edges: RelationEdges, a: string, b: string): RelationRefusal | null {
  if (a === b) return { kind: "self" };
  const pair = canonicalRelated(a, b);
  if (edges.related.some((e) => e.concept === pair.concept && e.target === pair.target)) return { kind: "exists" };
  if (broaderPath(edges.broader, a, b) || broaderPath(edges.broader, b, a)) return { kind: "redundant" };
  return null;
}

/** What a merge does to the relations of the loser (ADR-081 sixth addendum, step 7c). */
export interface MergedRelations {
  /** Every edge that names the loser, as it was: all of them go with it. */
  ofLoser: RelationEdges;
  dropped: {
    /** Broader edges between the loser and the winner: they would be self-loops. Original orientation. */
    broader: RelationEdge[];
    /** Related edges between the loser and the winner, likewise. */
    related: RelationEdge[];
    /**
     * Related edges whose pair is a broader pair after the merge (the loser
     * was related to `x`, the winner is below `x`): the two relations are
     * disjoint, so the related one goes. Canonical order; already stored or not.
     */
    hierarchical: RelationEdge[];
  };
  /** The loser's other edges, rewritten onto the winner, that are not there yet and are kept. */
  moved: { broader: RelationEdge[]; related: RelationEdge[] };
  /** Every edge after the merge. */
  after: RelationEdges;
  /** A longer broader cycle through the winner (first and last id equal), or null. The merge is then refused. */
  cycle: string[] | null;
}

const key = (e: RelationEdge) => `${e.concept}\u0000${e.target}`;
const bySort = (a: RelationEdge, b: RelationEdge) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/**
 * The relations after merging `loser` into `winner`: every edge naming the
 * loser names the winner instead; an edge between the two is dropped (it
 * would be a self-loop); a rewritten edge that exists already is not written
 * twice; a related edge whose pair is then also a broader pair is dropped
 * (`hierarchical`), so the two relations stay disjoint. A rewritten broader
 * edge may close a longer cycle (`loser` broader `x`, `x` broader `winner`):
 * the shortest one through the winner is returned and the caller refuses the
 * merge before writing anything. Lists are sorted.
 */
export function mergedRelations(edges: RelationEdges, loser: string, winner: string): MergedRelations {
  const touches = (e: RelationEdge) => e.concept === loser || e.target === loser;
  const between = (e: RelationEdge) => touches(e) && [e.concept, e.target].every((c) => c === loser || c === winner);
  const split = (list: readonly RelationEdge[], canonical: boolean) => {
    const present = new Set(list.filter((e) => !touches(e)).map(key));
    const moved: RelationEdge[] = [];
    for (const e of list.filter((e) => touches(e) && !between(e))) {
      const concept = e.concept === loser ? winner : e.concept;
      const target = e.target === loser ? winner : e.target;
      const rewritten = canonical ? canonicalRelated(concept, target) : { concept, target };
      if (!present.has(key(rewritten))) {
        present.add(key(rewritten));
        moved.push(rewritten);
      }
    }
    return { kept: list.filter((e) => !touches(e)), dropped: list.filter(between).sort(bySort), moved: moved.sort(bySort) };
  };
  const broader = split(edges.broader, false);
  const related = split(edges.related, true);
  const broaderAfter = [...broader.kept, ...broader.moved];
  const pairs = new Set(broaderAfter.map((e) => key(canonicalRelated(e.concept, e.target))));
  const relatedAfter = [...related.kept, ...related.moved];
  const hierarchical = relatedAfter.filter((e) => pairs.has(key(e))).sort(bySort);
  const keep = (e: RelationEdge) => !pairs.has(key(e));
  return {
    ofLoser: { broader: edges.broader.filter(touches), related: edges.related.filter(touches) },
    dropped: { broader: broader.dropped, related: related.dropped, hierarchical },
    moved: { broader: broader.moved, related: related.moved.filter(keep) },
    after: { broader: broaderAfter, related: relatedAfter.filter(keep) },
    cycle: broaderPath(broaderAfter, winner, winner),
  };
}
