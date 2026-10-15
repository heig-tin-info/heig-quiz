/**
 * Relations the curation screen proposes to the admin (#897 step A, ADR-114):
 * pure rules, no database, no model. Nothing here writes an edge: the admin
 * accepts a selection, and each accepted edge goes through the relation
 * routes and their rules ({@link checkBroaderEdge}, {@link checkRelatedEdge}).
 *
 * - {@link containedBroader}: a concept whose label contains another's whole
 *   label is probably narrower (`Arithmétique des pointeurs` under `Pointeur`).
 * - {@link relationCandidatesOf}: those, and the pairs of concepts that
 *   classify many of the same questions, as the route answers them.
 * - {@link admissible}: which proposals can all be accepted together.
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

/**
 * The thresholds and caps of the pre-pass (ADR-114 §1): at most `contained`
 * broader candidates; two concepts are a related candidate from `min` shared
 * live questions, at least `share` of the less-used one's; at most `together`.
 */
export const RELATION_CANDIDATE_LIMITS = { contained: 100, min: 3, share: 0.5, together: 50 } as const;

/** One edge to add: `broader` reads "`concept` has `target` as a broader concept"; `related` is either order. */
export interface RelationProposal {
  kind: "broader" | "related";
  concept: string;
  target: string;
}

/** A candidate of the pre-pass: a related one carries how many live questions the two share. */
export type RelationCandidate =
  | { kind: "broader"; concept: string; target: string; questions: null }
  | { kind: "related"; concept: string; target: string; questions: number };

/** The words of a label's key (`Arithmétique des pointeurs` → `arithmetique`, `pointeur`). */
const wordsOf = (text: string): string[] => {
  const key = conceptKey(text);
  return key ? key.split("-") : [];
};

const startsAt = (words: readonly string[], run: readonly string[], at: number) =>
  run.every((w, i) => words[at + i] === w);

const byIds = (x: RelationEdge, y: RelationEdge) =>
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
 * one goes. Merged concepts are ignored, and so is a target the chain already
 * holds above A, near or far (the relation rules, which read the direct edge
 * only, are {@link admissible}'s). Sorted by concept then target id.
 */
export function containedBroader(concepts: readonly ResolvableConcept[], edges: RelationEdges): RelationEdge[] {
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
      if (!dominated.has(target) && !broaderPath(edges.broader, a.id, target)) out.push({ concept: a.id, target });
    }
  }
  return out.sort(byIds);
}

/** Two concepts and how many live questions carry both; `smaller` is the live question count of the less-used one. */
export interface ConceptPairCount {
  a: string;
  b: string;
  shared: number;
  smaller: number;
}

/**
 * The proposals that can all be accepted together, in order: each is checked
 * by the relation rules against the edges plus the proposals kept before it,
 * so of `A > B` and `B > A` the first stays, and of a pair proposed both
 * broader and related the first stays.
 */
export function admissible<P extends RelationProposal>(edges: RelationEdges, proposals: readonly P[]): P[] {
  const work = { broader: [...edges.broader], related: [...edges.related] };
  return proposals.filter((p) => {
    const refused =
      p.kind === "broader" ? checkBroaderEdge(work, p.concept, p.target) : checkRelatedEdge(work, p.concept, p.target);
    if (refused) return false;
    if (p.kind === "broader") work.broader.push({ concept: p.concept, target: p.target });
    else work.related.push(canonicalRelated(p.concept, p.target));
    return true;
  });
}

/**
 * The whole pre-pass, as the route answers it: the containment candidates
 * ({@link containedBroader}), then the pairs on at least `min` live questions
 * together, at least `share` of the less-used one's, the most shared first,
 * in canonical order (`concept < target`); of those, only what can all be
 * accepted together ({@link admissible}, broader first: it also drops what
 * the relation rules refuse and a pair already proposed as broader); each
 * kind capped ({@link RELATION_CANDIDATE_LIMITS}).
 */
export function relationCandidatesOf(
  concepts: readonly ResolvableConcept[],
  edges: RelationEdges,
  pairs: readonly ConceptPairCount[],
): RelationCandidate[] {
  const limits = RELATION_CANDIDATE_LIMITS;
  const related = pairs
    .filter((p) => p.shared >= limits.min && p.shared / p.smaller >= limits.share)
    .map((p) => ({ kind: "related" as const, ...canonicalRelated(p.a, p.b), questions: p.shared }))
    .sort((x, y) => y.questions - x.questions || byIds(x, y));
  const kept = admissible<RelationCandidate>(edges, [
    ...containedBroader(concepts, edges).map((e) => ({ kind: "broader" as const, ...e, questions: null })),
    ...related,
  ]);
  return [
    ...kept.filter((c) => c.kind === "broader").slice(0, limits.contained),
    ...kept.filter((c) => c.kind === "related").slice(0, limits.together),
  ];
}
