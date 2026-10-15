/**
 * The Relations view of the curation queue (#897 step A1, ADR-114): the
 * candidates of `GET /admin/concepts/relations/candidates` as rows the admin
 * ticks, their state against the vocabulary as loaded, and the plan that
 * writes the ticked ones through the relation route, one at a time.
 */
import type { Concept, ConceptRelationCandidates } from "@quiz/contracts";
import {
  checkBroaderEdge,
  checkRelatedEdge,
  type RelationEdges,
  type RelationProposal,
  type RelationRefusal,
} from "@quiz/domain";

/**
 * One candidate: `a` gets `b` as a broader concept, or the two are related
 * (`concept` and `target` are their ids, as `admissible` reads them).
 * `questions` is how many live questions carry both, for a related one.
 */
export interface RelationRow<C extends Concept = Concept> extends RelationProposal {
  key: string;
  a: C;
  b: C;
  questions: number | null;
}

const rowKey = (kind: RelationProposal["kind"], x: string, y: string) => (x < y ? `${kind}:${x}:${y}` : `${kind}:${y}:${x}`);

/** The candidates as rows, in their order; a row naming a concept that is gone is dropped, and a pair of one kind appears once. */
export function rowsOf<C extends Concept>(candidates: ConceptRelationCandidates, concepts: readonly C[]): RelationRow<C>[] {
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const proposals: (RelationProposal & { questions: number | null })[] = [
    ...candidates.contained.map((e) => ({ kind: "broader" as const, ...e, questions: null })),
    ...candidates.together.map((p) => ({ kind: "related" as const, concept: p.a, target: p.b, questions: p.questions })),
  ];
  const seen = new Set<string>();
  return proposals.flatMap((p) => {
    const [a, b] = [byId.get(p.concept), byId.get(p.target)];
    const key = rowKey(p.kind, p.concept, p.target);
    if (!a || !b || seen.has(key)) return [];
    seen.add(key);
    return [{ ...p, key, a, b }];
  });
}

/** Where a row stands against the edges as loaded: still to accept, there already, or refused by the rule (a cycle, a hierarchy). */
export type RowState = { state: "open" } | { state: "added" } | { state: "blocked"; refusal: RelationRefusal };

export function rowState(row: RelationProposal, edges: RelationEdges): RowState {
  const refusal =
    row.kind === "broader" ? checkBroaderEdge(edges, row.concept, row.target) : checkRelatedEdge(edges, row.concept, row.target);
  if (!refusal) return { state: "open" };
  return refusal.kind === "exists" ? { state: "added" } : { state: "blocked", refusal };
}

/**
 * What accepting the ticked rows writes, in order: the broader edges first,
 * then the related ones (a broader edge just written may make a related pair
 * redundant, and the server then says so). `create` is the concepts to create
 * before them: none in A1, the model's top concepts in A2.
 */
export interface AcceptPlan<R extends RelationRow = RelationRow> {
  create: never[];
  edges: R[];
}

export function acceptPlan<R extends RelationRow>(selected: readonly R[]): AcceptPlan<R> {
  return {
    create: [],
    edges: [...selected.filter((r) => r.kind === "broader"), ...selected.filter((r) => r.kind === "related")],
  };
}

/** How one row's write ended: written, or the refusal to show on it. */
export type Outcome = { ok: true } | { error: unknown };

/** Writes the plan one edge at a time; a refused row never stops the others. Per row key. */
export async function runAccept<R extends RelationRow>(
  plan: AcceptPlan<R>,
  { relate }: { relate: (row: R) => Promise<unknown> },
): Promise<Map<string, Outcome>> {
  const out = new Map<string, Outcome>();
  for (const row of plan.edges) {
    try {
      await relate(row);
      out.set(row.key, { ok: true });
    } catch (error) {
      out.set(row.key, { error });
    }
  }
  return out;
}
