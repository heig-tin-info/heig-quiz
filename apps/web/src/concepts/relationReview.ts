/**
 * The Relations view of the curation queue (#897 step A1, ADR-114): the
 * candidates of `GET /admin/concepts/relations/candidates` as rows the admin
 * ticks, their state against the vocabulary as loaded, and the writes of the
 * ticked ones through the relation route, one at a time.
 */
import type { AdminConcept, ConceptRelationCandidate } from "@quiz/contracts";
import { checkBroaderEdge, checkRelatedEdge, type RelationEdges, type RelationRefusal } from "@quiz/domain";

/** One candidate with its two concepts: `a` is `concept`, `b` is `target`. */
export type RelationRow = ConceptRelationCandidate & { key: string; a: AdminConcept; b: AdminConcept };

/** The candidates as rows, in their order; a row naming a concept that is gone (merged, deleted) is dropped. */
export function rowsOf(candidates: readonly ConceptRelationCandidate[], concepts: readonly AdminConcept[]): RelationRow[] {
  const byId = new Map(concepts.map((c) => [c.id, c]));
  return candidates.flatMap((c) => {
    const [a, b] = [byId.get(c.concept), byId.get(c.target)];
    return a && b ? [{ ...c, key: `${c.kind}:${c.concept}:${c.target}`, a, b }] : [];
  });
}

/** Where a row stands against the edges as loaded: still to accept, there already, or refused by the rule (a cycle, a hierarchy). */
export type RowState = { state: "open" } | { state: "added" } | { state: "blocked"; refusal: RelationRefusal };

export function rowState(row: ConceptRelationCandidate, edges: RelationEdges): RowState {
  const refusal =
    row.kind === "broader" ? checkBroaderEdge(edges, row.concept, row.target) : checkRelatedEdge(edges, row.concept, row.target);
  if (!refusal) return { state: "open" };
  return refusal.kind === "exists" ? { state: "added" } : { state: "blocked", refusal };
}

/** How one row's write ended: written, or the refusal to show on it. */
export type Outcome = { ok: true } | { error: unknown };

/**
 * Writes the ticked rows one at a time, the broader edges first (one just
 * written may make a related pair redundant, and the server then says so); a
 * refused row never stops the others. Per row key.
 */
export async function runAccept(
  rows: readonly RelationRow[],
  relate: (row: RelationRow) => Promise<unknown>,
): Promise<Map<string, Outcome>> {
  const out = new Map<string, Outcome>();
  const ordered = [...rows].sort((x, y) => Number(x.kind === "related") - Number(y.kind === "related"));
  for (const row of ordered) {
    try {
      await relate(row);
      out.set(row.key, { ok: true });
    } catch (error) {
      out.set(row.key, { error });
    }
  }
  return out;
}
