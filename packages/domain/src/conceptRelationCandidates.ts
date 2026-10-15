/**
 * Relations the curation screen proposes to the admin (#897 step A, ADR-114):
 * pure rules, no database, no model. Nothing here writes an edge: the admin
 * accepts a selection, and each accepted edge goes through the relation
 * routes and their rules ({@link checkBroaderEdge}, {@link checkRelatedEdge}).
 *
 * - {@link containedBroader}: a concept whose label contains another's whole
 *   label is probably narrower (`Arithmétique des pointeurs` under `Pointeur`).
 * - {@link coOccurringRelated}: two concepts that classify many of the same
 *   questions are probably related.
 * - {@link admissible}: which proposals can all be accepted together.
 * - {@link relationCandidatesOf}: the three, as the route answers.
 */
import {
  broaderPath,
  canonicalRelated,
  checkBroaderEdge,
  checkRelatedEdge,
  type RelationEdge,
  type RelationEdges,
} from "./conceptRelations.js";
import { conceptKey, type ResolvableConcept } from "./concepts.js";

/** One edge to add: `broader` reads "`concept` has `target` as a broader concept"; `related` is either order. */
export interface RelationProposal {
  kind: "broader" | "related";
  concept: string;
  target: string;
}

/** The words of a label's key (`Arithmétique des pointeurs` → `arithmetique`, `pointeur`). */
const wordsOf = (text: string): string[] => {
  const key = conceptKey(text);
  return key ? key.split("-") : [];
};

const startsAt = (words: readonly string[], run: readonly string[], at: number) =>
  run.every((w, i) => words[at + i] === w);

const byEdge = (x: RelationEdge, y: RelationEdge) =>
  x.concept < y.concept ? -1 : x.concept > y.concept ? 1 : x.target < y.target ? -1 : x.target > y.target ? 1 : 0;

/** A label of a live concept, as the containment reads it. */
interface Name {
  id: string;
  lang: string | undefined;
  words: string[];
  qualifier: string[];
}

/**
 * The broader candidates found by label containment: B is proposed above A
 * when, in one language, the words of B's label key form a contiguous run of
 * A's label words and A has strictly more words. A qualified target
 * (`Adresse (mémoire)`) matches only when the words of its qualifier are
 * among A's label or qualifier words, so `Adresse IP` never lands under a
 * homonym. Only the most specific match is kept: when one matched run lies
 * inside another (`pointeur` inside `arithmetique-pointeur`), the shorter
 * one goes. Merged concepts are ignored; an edge the chain already holds
 * (near or far) or that {@link checkBroaderEdge} refuses is dropped. Sorted
 * by concept then target id, at most `max`.
 */
export function containedBroader(
  concepts: readonly ResolvableConcept[],
  edges: RelationEdges,
  max: number,
): RelationEdge[] {
  const live = concepts.filter((c) => !c.mergedInto);
  const byFirst = new Map<string, Name[]>();
  for (const c of live) {
    for (const l of c.labels) {
      const name: Name = { id: c.id, lang: l.lang, words: wordsOf(l.label), qualifier: wordsOf(l.qualifier) };
      if (name.words.length > 0) byFirst.set(name.words[0]!, [...(byFirst.get(name.words[0]!) ?? []), name]);
    }
  }
  const out: RelationEdge[] = [];
  for (const a of live) {
    const kept = new Set<string>();
    const dominated = new Set<string>();
    for (const l of a.labels) {
      const words = wordsOf(l.label);
      const context = new Set([...words, ...wordsOf(l.qualifier)]);
      const spans: { id: string; from: number; to: number }[] = [];
      words.forEach((word, at) => {
        for (const t of byFirst.get(word) ?? []) {
          if (t.id === a.id || t.lang !== l.lang || t.words.length >= words.length) continue;
          if (!startsAt(words, t.words, at) || !t.qualifier.every((w) => context.has(w))) continue;
          spans.push({ id: t.id, from: at, to: at + t.words.length });
        }
      });
      for (const s of spans) {
        const inside = spans.some((o) => o.to - o.from > s.to - s.from && o.from <= s.from && s.to <= o.to);
        (inside ? dominated : kept).add(s.id);
      }
    }
    for (const target of kept) {
      if (dominated.has(target)) continue;
      if (broaderPath(edges.broader, a.id, target) || checkBroaderEdge(edges, a.id, target)) continue;
      out.push({ concept: a.id, target });
    }
  }
  return out.sort(byEdge).slice(0, max);
}

/** Two concepts and how many live questions carry both; `smaller` is the live question count of the less-used one. */
export interface ConceptPairCount {
  a: string;
  b: string;
  shared: number;
  smaller: number;
}

/**
 * The related candidates found by co-occurrence: two concepts on at least
 * `min` live questions together, which is at least `share` of the less-used
 * one's live questions. A pair {@link checkRelatedEdge} refuses (related
 * already, or one in the other's broader chain) or one in `taken` (proposed
 * as broader already, either order) is dropped. Canonical order (`a < b`),
 * sorted by count, the larger first, then ids; at most `max`.
 */
export function coOccurringRelated(
  pairs: readonly ConceptPairCount[],
  edges: RelationEdges,
  opts: { min: number; share: number; max: number; taken: readonly RelationEdge[] },
): { a: string; b: string; questions: number }[] {
  const pairKey = (x: string, y: string) => {
    const e = canonicalRelated(x, y);
    return `${e.concept}\u0000${e.target}`;
  };
  const taken = new Set(opts.taken.map((e) => pairKey(e.concept, e.target)));
  return pairs
    .filter((p) => p.shared >= opts.min && p.smaller > 0 && p.shared / p.smaller >= opts.share)
    .filter((p) => !taken.has(pairKey(p.a, p.b)) && !checkRelatedEdge(edges, p.a, p.b))
    .map((p) => {
      const e = canonicalRelated(p.a, p.b);
      return { a: e.concept, b: e.target, questions: p.shared };
    })
    .sort((x, y) => y.questions - x.questions || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0))
    .slice(0, opts.max);
}

/**
 * The proposals that can all be accepted together, in order: each is checked
 * against the edges plus the proposals kept before it, so of `A > B` and
 * `B > A` the first stays, and of a pair proposed both broader and related
 * the first stays. `broaderPerConcept` caps the broader proposals kept for
 * one concept (its existing broader concepts are not counted).
 */
export function admissible<P extends RelationProposal>(
  edges: RelationEdges,
  proposals: readonly P[],
  opts: { broaderPerConcept?: number } = {},
): P[] {
  const work = { broader: [...edges.broader], related: [...edges.related] };
  const added = new Map<string, number>();
  return proposals.filter((p) => {
    if (p.kind === "related") {
      if (checkRelatedEdge(work, p.concept, p.target)) return false;
      work.related.push(canonicalRelated(p.concept, p.target));
      return true;
    }
    const n = added.get(p.concept) ?? 0;
    if (n >= (opts.broaderPerConcept ?? Infinity) || checkBroaderEdge(work, p.concept, p.target)) return false;
    work.broader.push({ concept: p.concept, target: p.target });
    added.set(p.concept, n + 1);
    return true;
  });
}

/**
 * The whole pre-pass, as the route answers it: the containment candidates,
 * the co-occurrence ones not already proposed as broader, then only those
 * that can all be accepted together ({@link admissible}, broader first).
 */
export function relationCandidatesOf(
  concepts: readonly ResolvableConcept[],
  edges: RelationEdges,
  pairs: readonly ConceptPairCount[],
  limits: { containmentMax: number; min: number; share: number; togetherMax: number },
): { contained: RelationEdge[]; together: { a: string; b: string; questions: number }[] } {
  const contained = containedBroader(concepts, edges, limits.containmentMax);
  const together = coOccurringRelated(pairs, edges, { ...limits, max: limits.togetherMax, taken: contained });
  const kept = admissible(edges, [
    ...contained.map((e) => ({ kind: "broader" as const, ...e, questions: 0 })),
    ...together.map((p) => ({ kind: "related" as const, concept: p.a, target: p.b, questions: p.questions })),
  ]);
  return {
    contained: kept.filter((p) => p.kind === "broader").map(({ concept, target }) => ({ concept, target })),
    together: kept.filter((p) => p.kind === "related").map(({ concept, target, questions }) => ({ a: concept, b: target, questions })),
  };
}
