import { describe, expect, it } from "vitest";

import { admissible, coOccurringRelated, containedBroader, relationCandidatesOf, type RelationProposal } from "./conceptRelationCandidates.js";
import type { RelationEdge, RelationEdges } from "./conceptRelations.js";
import type { ResolvableConcept } from "./concepts.js";

const none: RelationEdges = { broader: [], related: [] };
const e = (concept: string, target: string): RelationEdge => ({ concept, target });

/** A live concept with a French label, and an English one when given. */
function c(id: string, fr: string, en?: string, quals: { fr?: string; en?: string } = {}): ResolvableConcept {
  return {
    id,
    mergedInto: null,
    aliases: [],
    labels: [
      { label: fr, qualifier: quals.fr ?? "", lang: "fr" as const },
      ...(en ? [{ label: en, qualifier: quals.en ?? "", lang: "en" as const }] : []),
    ],
  };
}

describe("containedBroader", () => {
  const pointer = c("p", "Pointeur", "Pointer");
  const arith = c("ar", "Arithmétique des pointeurs", "Pointer arithmetic");
  const nullArith = c("na", "Arithmétique des pointeurs nuls", "Null pointer arithmetic");

  it("proposes a label contained in another as its broader concept", () => {
    expect(containedBroader([pointer, arith], none, 10)).toEqual([e("ar", "p")]);
  });

  it("keeps the most specific match only", () => {
    expect(containedBroader([pointer, arith, nullArith], none, 10)).toEqual([e("ar", "p"), e("na", "ar")]);
  });

  it("needs a contiguous run and strictly more words", () => {
    const pile = c("pi", "Pile");
    const pileAppels = c("pa", "Pile d'appels");
    const appelsPile = c("ap", "Appels sur la pile");
    const split = c("sp", "Pile de fonctions et appels");
    const callStack = c("cs", "Appels pile");
    const same = c("s2", "Piles");
    expect(containedBroader([pile, pileAppels, same], none, 10)).toEqual([e("pa", "pi"), e("pa", "s2")]);
    // "pile appel" is not a contiguous run of "pile fonction et appel".
    expect(containedBroader([pileAppels, split], none, 10)).toEqual([]);
    expect(containedBroader([callStack, appelsPile], none, 10)).toEqual([]);
  });

  it("never matches across languages", () => {
    const fr = c("fr", "Tableau");
    const en: ResolvableConcept = { id: "en", mergedInto: null, aliases: [], labels: [{ label: "Tableau dynamique", qualifier: "", lang: "en" }] };
    expect(containedBroader([fr, en], none, 10)).toEqual([]);
  });

  it("matches a qualified target only when the qualifier's words are there too", () => {
    const memory = c("am", "Adresse", undefined, { fr: "mémoire" });
    const ip = c("ip", "Adresse IP");
    const memAddr = c("ma", "Adresse mémoire virtuelle");
    const qualified = c("aq", "Adresse physique", undefined, { fr: "mémoire" });
    expect(containedBroader([memory, ip, memAddr, qualified], none, 10)).toEqual([e("aq", "am"), e("ma", "am")]);
  });

  it("ignores merged concepts", () => {
    expect(containedBroader([{ ...pointer, mergedInto: "x" }, arith], none, 10)).toEqual([]);
    expect(containedBroader([pointer, { ...arith, mergedInto: "x" }], none, 10)).toEqual([]);
  });

  it("drops what the chain holds and what the rules refuse", () => {
    const top = c("t", "Programmation");
    // Held directly, and held through a longer chain.
    expect(containedBroader([pointer, arith], { broader: [e("ar", "p")], related: [] }, 10)).toEqual([]);
    expect(containedBroader([pointer, arith, top], { broader: [e("ar", "t"), e("t", "p")], related: [] }, 10)).toEqual([]);
    // A cycle: the pointer is already below the arithmetic.
    expect(containedBroader([pointer, arith], { broader: [e("p", "ar")], related: [] }, 10)).toEqual([]);
    // Related already.
    expect(containedBroader([pointer, arith], { broader: [], related: [e("ar", "p")] }, 10)).toEqual([]);
  });

  it("is ordered by ids and capped", () => {
    const list = [c("z", "Tri"), c("b", "Tri rapide"), c("a", "Tri fusion"), c("c", "Tri bulle")];
    expect(containedBroader(list, none, 2)).toEqual([e("a", "z"), e("b", "z")]);
    expect(containedBroader([...list].reverse(), none, 10)).toEqual(containedBroader(list, none, 10));
  });
});

describe("coOccurringRelated", () => {
  const opts = { min: 3, share: 0.5, max: 10, taken: [] as RelationEdge[] };

  it("keeps the pairs over both thresholds, in canonical order, most shared first", () => {
    const pairs = [
      { a: "b", b: "a", shared: 3, smaller: 6 },
      { a: "c", b: "d", shared: 5, smaller: 5 },
      { a: "e", b: "f", shared: 2, smaller: 2 },
      { a: "g", b: "h", shared: 3, smaller: 7 },
    ];
    expect(coOccurringRelated(pairs, none, opts)).toEqual([
      { a: "c", b: "d", questions: 5 },
      { a: "a", b: "b", questions: 3 },
    ]);
  });

  it("drops what the rules refuse and what is taken as broader", () => {
    const pairs = [
      { a: "a", b: "b", shared: 4, smaller: 4 },
      { a: "c", b: "d", shared: 4, smaller: 4 },
      { a: "e", b: "f", shared: 4, smaller: 4 },
      { a: "g", b: "h", shared: 4, smaller: 4 },
    ];
    const edges = { broader: [e("c", "x"), e("x", "d")], related: [e("a", "b")] };
    expect(coOccurringRelated(pairs, edges, { ...opts, taken: [e("f", "e")] })).toEqual([{ a: "g", b: "h", questions: 4 }]);
  });

  it("orders ties by ids and caps", () => {
    const pairs = [
      { a: "c", b: "d", shared: 3, smaller: 3 },
      { a: "a", b: "b", shared: 3, smaller: 3 },
    ];
    expect(coOccurringRelated(pairs, none, { ...opts, max: 1 })).toEqual([{ a: "a", b: "b", questions: 3 }]);
  });
});

describe("admissible", () => {
  const p = (kind: RelationProposal["kind"], concept: string, target: string): RelationProposal => ({ kind, concept, target });

  it("keeps the first of two opposite broader edges", () => {
    expect(admissible(none, [p("broader", "a", "b"), p("broader", "b", "a")])).toEqual([p("broader", "a", "b")]);
  });

  it("keeps the first of a pair proposed both ways", () => {
    expect(admissible(none, [p("broader", "a", "b"), p("related", "b", "a")])).toEqual([p("broader", "a", "b")]);
    expect(admissible(none, [p("related", "a", "b"), p("broader", "a", "b")])).toEqual([p("related", "a", "b")]);
  });

  it("sees a cycle closed through the edges kept before", () => {
    const edges = { broader: [e("c", "a")], related: [] };
    expect(admissible(edges, [p("broader", "a", "b"), p("broader", "b", "c"), p("related", "a", "d")])).toEqual([
      p("broader", "a", "b"),
      p("related", "a", "d"),
    ]);
  });

  it("drops a related pair a kept broader edge puts in one chain", () => {
    const edges = { broader: [e("b", "c")], related: [] };
    expect(admissible(edges, [p("broader", "a", "b"), p("related", "a", "c")])).toEqual([p("broader", "a", "b")]);
  });

  it("caps the broader proposals per concept, existing ones aside", () => {
    const edges = { broader: [e("a", "z")], related: [] };
    const out = admissible(edges, [p("broader", "a", "b"), p("broader", "a", "c"), p("broader", "d", "c")], { broaderPerConcept: 1 });
    expect(out).toEqual([p("broader", "a", "b"), p("broader", "d", "c")]);
  });

  it("serves the whole pre-pass: no pair twice, and only proposals that can all be accepted together", () => {
    const limits = { containmentMax: 10, min: 3, share: 0.5, togetherMax: 10 };
    const vocabulary = [c("a", "Tri rapide stable"), c("b", "Tri rapide"), c("c", "Tri"), c("d", "Pile")];
    // c is under a already: a > b and b > c are each fine, together they close a cycle; the first stays.
    const edges = { broader: [e("c", "a")], related: [] };
    const pairs = [
      { a: "a", b: "b", shared: 5, smaller: 5 },
      { a: "c", b: "d", shared: 4, smaller: 4 },
    ];
    expect(relationCandidatesOf(vocabulary, edges, pairs, limits)).toEqual({
      contained: [e("a", "b")],
      together: [{ a: "c", b: "d", questions: 4 }],
    });
  });

  it("does not change the edges it is given", () => {
    const edges = { broader: [], related: [] };
    admissible(edges, [p("broader", "a", "b")]);
    expect(edges).toEqual({ broader: [], related: [] });
  });
});
