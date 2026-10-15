/**
 * The Relations view of the curation queue (#897 step A, ADR-114): the
 * candidates of `GET /admin/concepts/relations/candidates` and the model's
 * proposals (`POST /admin/concepts/relations/ai`) as rows the admin ticks,
 * their state against the vocabulary as loaded, and the writes of the ticked
 * ones: a missing top concept created first, then each edge through the
 * relation route, one at a time.
 */
import {
  type AdminConcept,
  ConceptExists,
  type ConceptLang,
  type ConceptRelationCandidate,
  type ConceptRelationProposals,
} from "@quiz/contracts";
import {
  admissible,
  canonicalRelated,
  checkBroaderEdge,
  checkRelatedEdge,
  qualifiedConceptKey,
  type RelationEdges,
  type RelationRefusal,
} from "@quiz/domain";

import { ApiError } from "../api";

/** A top concept the vocabulary lacks, as the model named it: created `proposed`, in `lang`, when a ticked row carries it. */
export interface TopConcept {
  /** Its qualified key in `lang`: one top per key. */
  key: string;
  lang: ConceptLang;
  label: string;
  qualifier: string;
  reason: string;
}

/**
 * One proposed edge with its two concepts: `a` is `concept`, `b` is `target`
 * — null for a row under a top concept not created yet, whose `target` is
 * then a placeholder (`top:<key>`) that no rule finds in the graph.
 */
export interface RelationRow {
  key: string;
  kind: "broader" | "related";
  concept: string;
  target: string;
  a: AdminConcept;
  b: AdminConcept | null;
  /** The pre-pass's live questions together (a related candidate). */
  questions: number | null;
  /** The model's reason (a related pair). */
  reason: string | null;
  /** The missing top concept the row puts `a` under. */
  top: TopConcept | null;
}

const row = (r: Omit<RelationRow, "key" | "questions" | "reason" | "top"> & Partial<RelationRow>): RelationRow => ({
  key: `${r.kind}:${r.concept}:${r.target}`,
  questions: null,
  reason: null,
  top: null,
  ...r,
});

/** The candidates as rows, in their order; a row naming a concept that is gone (merged, deleted) is dropped. */
export function rowsOf(candidates: readonly ConceptRelationCandidate[], concepts: readonly AdminConcept[]): RelationRow[] {
  const byId = new Map(concepts.map((c) => [c.id, c]));
  return candidates.flatMap((c) => {
    const [a, b] = [byId.get(c.concept), byId.get(c.target)];
    return a && b ? [row({ ...c, a, b })] : [];
  });
}

const pairOf = (r: Pick<RelationRow, "kind" | "concept" | "target">) => {
  const { concept, target } = canonicalRelated(r.concept, r.target);
  return `${r.kind}:${concept}:${target}`;
};

/**
 * The model's proposals as rows: its broader rows, its related pairs, then
 * the rows of each missing top concept. A row naming a concept that is gone
 * is dropped, and so is a row the pre-pass already lists (same kind, same
 * pair in either order). A top the vocabulary now holds (created by an
 * earlier Accept) is that concept.
 */
export function aiRowsOf(
  result: ConceptRelationProposals | undefined,
  concepts: readonly AdminConcept[],
  prepass: readonly RelationRow[],
): RelationRow[] {
  if (!result) return [];
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const listed = new Set(prepass.map(pairOf));
  const out: RelationRow[] = [];
  const add = (r: Omit<RelationRow, "key" | "questions" | "reason" | "top" | "a" | "b"> & Partial<RelationRow>) => {
    const a = byId.get(r.concept);
    const b = r.top && !byId.has(r.target) ? null : byId.get(r.target);
    if (a && b !== undefined && !listed.has(pairOf(r))) out.push(row({ ...r, a, b }));
  };
  for (const e of result.broader) add({ kind: "broader", ...e });
  for (const p of result.related) add({ kind: "related", concept: p.a, target: p.b, reason: p.reason });
  for (const t of result.tops) {
    const top = { key: qualifiedConceptKey(t.label, t.qualifier), lang: result.lang, label: t.label, qualifier: t.qualifier, reason: t.reason };
    const held = concepts.find((c) => c.labels[top.lang] !== null && qualifiedConceptKey(c.labels[top.lang]!, c.qualifiers[top.lang]) === top.key);
    const target = held?.id ?? `top:${top.key}`;
    for (const n of t.narrower) add({ kind: "broader", concept: n, target, top, key: `top:${top.key}:${n}` });
  }
  return out;
}

/** Where a row stands against the edges as loaded: still to accept, there already, or refused by the rule (a cycle, a hierarchy). */
export type RowState = { state: "open" } | { state: "added" } | { state: "blocked"; refusal: RelationRefusal };

export function rowState(r: Pick<RelationRow, "kind" | "concept" | "target">, edges: RelationEdges): RowState {
  const refusal = r.kind === "broader" ? checkBroaderEdge(edges, r.concept, r.target) : checkRelatedEdge(edges, r.concept, r.target);
  if (!refusal) return { state: "open" };
  return refusal.kind === "exists" ? { state: "added" } : { state: "blocked", refusal };
}

/** Broader rows first: one written may make a related pair redundant. */
const broaderFirst = <R extends Pick<RelationRow, "kind">>(rows: readonly R[]): R[] =>
  [...rows].sort((x, y) => Number(x.kind === "related") - Number(y.kind === "related"));

/**
 * The rows a ticked set rules out: open against the vocabulary, but refused
 * once the ticked edges are added (`admissible`) — the pre-pass's and the
 * model's lists were each consistent alone, not together.
 */
export function conflicting(rows: readonly RelationRow[], ticked: readonly RelationRow[], edges: RelationEdges): Set<string> {
  if (ticked.length === 0) return new Set();
  const kept = admissible(edges, broaderFirst(ticked));
  const work: RelationEdges = {
    broader: [...edges.broader, ...kept.filter((r) => r.kind === "broader")],
    related: [...edges.related, ...kept.filter((r) => r.kind === "related").map((r) => canonicalRelated(r.concept, r.target))],
  };
  const chosen = new Set(ticked.map((r) => r.key));
  return new Set(
    rows
      .filter((r) => !chosen.has(r.key) && rowState(r, edges).state === "open" && rowState(r, work).state !== "open")
      .map((r) => r.key),
  );
}

/** How one row's write ended: written, or the refusal to show on it. */
export type Outcome = { ok: true } | { error: unknown };

/** The concept a `409 concept_exists` names: it was there already, or someone created it meanwhile. */
const existing = (error: unknown): string | null => {
  const parsed = error instanceof ApiError ? ConceptExists.safeParse(error.body) : null;
  return parsed?.success ? parsed.data.concept.id : null;
};

/**
 * Writes the ticked rows: each missing top concept they carry is created
 * once, first (a `409 concept_exists` reuses the concept it names; any other
 * failure fails every row of that top), then the edges one at a time, the
 * broader ones first. A refused row never stops the others. Per row key.
 */
export async function runAccept(
  rows: readonly RelationRow[],
  write: {
    create: (top: TopConcept) => Promise<{ id: string }>;
    relate: (row: RelationRow, target: string) => Promise<unknown>;
  },
): Promise<Map<string, Outcome>> {
  const created = new Map<string, string | { error: unknown }>();
  for (const { top, b } of rows) {
    if (!top || b || created.has(top.key)) continue;
    try {
      created.set(top.key, (await write.create(top)).id);
    } catch (error) {
      created.set(top.key, existing(error) ?? { error });
    }
  }
  const out = new Map<string, Outcome>();
  for (const r of broaderFirst(rows)) {
    const target = r.top && !r.b ? created.get(r.top.key)! : r.target;
    if (typeof target !== "string") {
      out.set(r.key, target);
      continue;
    }
    try {
      await write.relate(r, target);
      out.set(r.key, { ok: true });
    } catch (error) {
      out.set(r.key, { error });
    }
  }
  return out;
}
