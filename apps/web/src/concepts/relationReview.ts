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
  type Concept,
  type ConceptCreate,
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
  withProposals,
  type RelationEdges,
  type RelationRefusal,
} from "@quiz/domain";

import { api, ApiError } from "../api";

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
 * One proposed edge: `a` is `concept`; `b` is `target`, or the top concept
 * not created yet — the row's `target` is then a placeholder (`top:<key>`)
 * that no rule finds in the graph.
 */
export interface RelationRow {
  key: string;
  kind: "broader" | "related";
  concept: string;
  target: string;
  a: AdminConcept;
  b: AdminConcept | TopConcept;
  /** The pre-pass's live questions together (a related candidate). */
  questions: number | null;
  /** The model's reason (a related pair). */
  reason: string | null;
  /** The missing top concept the row puts `a` under, created or not: what groups the row. */
  top: TopConcept | null;
}

/** Whether a row's `b` is a concept of the vocabulary (else a top concept to create). */
export const isConcept = (b: AdminConcept | TopConcept): b is AdminConcept => "id" in b;

type RowFields = Pick<RelationRow, "kind" | "concept" | "target" | "a" | "b"> & Partial<RelationRow>;
const row = (r: RowFields): RelationRow => ({ key: `${r.kind}:${r.concept}:${r.target}`, questions: null, reason: null, top: null, ...r });

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
  const add = (r: Omit<RowFields, "a" | "b">, b: AdminConcept | TopConcept | undefined) => {
    const a = byId.get(r.concept);
    if (a && b && !listed.has(pairOf(r))) out.push(row({ ...r, a, b }));
  };
  for (const e of result.broader) add({ kind: "broader", ...e }, byId.get(e.target));
  for (const p of result.related) add({ kind: "related", concept: p.a, target: p.b, reason: p.reason }, byId.get(p.b));
  for (const t of result.tops) {
    const top = { key: qualifiedConceptKey(t.label, t.qualifier), lang: result.lang, label: t.label, qualifier: t.qualifier, reason: t.reason };
    const held = concepts.find((c) => {
      const label = c.labels[top.lang];
      return label !== null && qualifiedConceptKey(label, c.qualifiers[top.lang]) === top.key;
    });
    const target = held?.id ?? `top:${top.key}`;
    for (const n of t.narrower) add({ kind: "broader", concept: n, target, top, key: `top:${top.key}:${n}` }, held ?? top);
  }
  return out;
}

/**
 * The model's broader rows for ONE concept (the sheet's Suggest a broader
 * concept, ADR-114 §3): its rows towards an existing concept and towards a
 * missing top concept; every other row of the reply is left out.
 */
export const broaderRowsFor = (
  result: ConceptRelationProposals | undefined,
  concepts: readonly AdminConcept[],
  conceptId: string,
): RelationRow[] => aiRowsOf(result, concepts, []).filter((r) => r.kind === "broader" && r.concept === conceptId);

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
 * once the ticked edges are added (`admissible`, `withProposals`) — the
 * pre-pass's and the model's lists were each consistent alone, not together.
 */
export function conflicting(rows: readonly RelationRow[], ticked: readonly RelationRow[], edges: RelationEdges): Set<string> {
  if (ticked.length === 0) return new Set();
  const work = withProposals(edges, admissible(edges, broaderFirst(ticked)));
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

/** Creates a missing top concept, `proposed`, in its language: the concept creation route (audited `concept.propose`). */
export const createTop = (top: TopConcept): Promise<Concept> =>
  api<Concept>("/app/api/concepts", {
    method: "POST",
    body: JSON.stringify({ lang: top.lang, label: top.label, qualifier: top.qualifier } satisfies ConceptCreate),
  });

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
  for (const { b } of rows) {
    if (isConcept(b) || created.has(b.key)) continue;
    try {
      created.set(b.key, (await write.create(b)).id);
    } catch (error) {
      created.set(b.key, existing(error) ?? { error });
    }
  }
  const out = new Map<string, Outcome>();
  for (const r of broaderFirst(rows)) {
    const target = isConcept(r.b) ? r.b.id : (created.get(r.b.key) ?? { error: null });
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
