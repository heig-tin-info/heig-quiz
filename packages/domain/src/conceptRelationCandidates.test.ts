import { describe, expect, it } from "vitest";

import {
  admissible,
  containedBroader,
  RELATION_CANDIDATE_LIMITS,
  relationCandidatesOf,
  type RelationProposal,
} from "./conceptRelationCandidates.js";
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
    expect(containedBroader([pointer, arith], none)).toEqual([e("ar", "p")]);
  });

  it("keeps the most specific match only", () => {
    expect(containedBroader([pointer, arith, nullArith], none)).toEqual([e("ar", "p"), e("na", "ar")]);
  });

  it("needs a contiguous run and strictly more words", () => {
    const pile = c("pi", "Pile");
    const pileAppels = c("pa", "Pile d'appels");
    const appelsPile = c("ap", "Appels sur la pile");
    const split = c("sp", "Pile de fonctions et appels");
    const callStack = c("cs", "Appels pile");
    const same = c("s2", "Piles");
    expect(containedBroader([pile, pileAppels, same], none)).toEqual([e("pa", "pi"), e("pa", "s2")]);
    // "pile appel" is not a contiguous run of "pile fonction et appel".
    expect(containedBroader([pileAppels, split], none)).toEqual([]);
    expect(containedBroader([callStack, appelsPile], none)).toEqual([]);
  });

  it("never matches across languages", () => {
    const fr = c("fr", "Tableau");
    const en: ResolvableConcept = { id: "en", mergedInto: null, aliases: [], labels: [{ label: "Tableau dynamique", qualifier: "", lang: "en" }] };
    expect(containedBroader([fr, en], none)).toEqual([]);
  });

  it("matches a qualified target only when the qualifier's words are there too", () => {
    const memory = c("am", "Adresse", undefined, { fr: "mémoire" });
    const ip = c("ip", "Adresse IP");
    const memAddr = c("ma", "Adresse mémoire virtuelle");
    const qualified = c("aq", "Adresse physique", undefined, { fr: "mémoire" });
    expect(containedBroader([memory, ip, memAddr, qualified], none)).toEqual([e("aq", "am"), e("ma", "am")]);
  });

  it("ignores merged concepts", () => {
    expect(containedBroader([{ ...pointer, mergedInto: "x" }, arith], none)).toEqual([]);
    expect(containedBroader([pointer, { ...arith, mergedInto: "x" }], none)).toEqual([]);
  });

  it("drops what the chain already holds, near or far", () => {
    const top = c("t", "Programmation");
    expect(containedBroader([pointer, arith], { broader: [e("ar", "p")], related: [] })).toEqual([]);
    expect(containedBroader([pointer, arith, top], { broader: [e("ar", "t"), e("t", "p")], related: [] })).toEqual([]);
  });

  it("is ordered by ids", () => {
    const list = [c("z", "Tri"), c("b", "Tri rapide"), c("a", "Tri fusion"), c("c", "Tri bulle")];
    expect(containedBroader(list, none)).toEqual([e("a", "z"), e("b", "z"), e("c", "z")]);
    expect(containedBroader([...list].reverse(), none)).toEqual(containedBroader(list, none));
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

  it("drops a related pair a kept broader edge puts in one chain, and what exists", () => {
    const edges = { broader: [e("b", "c")], related: [e("d", "e")] };
    expect(admissible(edges, [p("broader", "a", "b"), p("related", "a", "c"), p("related", "e", "d")])).toEqual([
      p("broader", "a", "b"),
    ]);
  });

  it("does not change the edges it is given", () => {
    const edges = { broader: [], related: [] };
    admissible(edges, [p("broader", "a", "b")]);
    expect(edges).toEqual({ broader: [], related: [] });
  });
});

describe("relationCandidatesOf", () => {
  const pair = (a: string, b: string, shared: number, smaller: number) => ({ a, b, shared, smaller });

  it("keeps the pairs over both thresholds, in canonical order, most shared first", () => {
    const pairs = [pair("b", "a", 3, 6), pair("c", "d", 5, 5), pair("e", "f", 2, 2), pair("g", "h", 3, 7)];
    expect(relationCandidatesOf([], none, pairs)).toEqual([
      { kind: "related", concept: "c", target: "d", questions: 5 },
      { kind: "related", concept: "a", target: "b", questions: 3 },
    ]);
  });

  it("lists broader candidates first, and only what can all be accepted together", () => {
    const vocabulary = [c("a", "Tri rapide stable"), c("b", "Tri rapide"), c("c", "Tri"), c("d", "Pile")];
    // c is under a already: a > b and b > c are each fine, together they close a cycle; the first stays.
    // a and b are proposed as broader, so not as related; c and d go through.
    const edges = { broader: [e("c", "a")], related: [] };
    expect(relationCandidatesOf(vocabulary, edges, [pair("a", "b", 5, 5), pair("c", "d", 4, 4)])).toEqual([
      { kind: "broader", concept: "a", target: "b", questions: null },
      { kind: "related", concept: "c", target: "d", questions: 4 },
    ]);
  });

  it("drops what the relation rules refuse", () => {
    const vocabulary = [c("p", "Pointeur"), c("ar", "Arithmétique des pointeurs")];
    // A cycle (the pointer is under the arithmetic already), a related pair, a related pair in one chain.
    expect(relationCandidatesOf(vocabulary, { broader: [e("p", "ar")], related: [] }, [pair("p", "ar", 4, 4)])).toEqual([]);
    expect(relationCandidatesOf(vocabulary, { broader: [], related: [e("ar", "p")] }, [])).toEqual([]);
  });

  it("caps each kind", () => {
    const { contained, together } = RELATION_CANDIDATE_LIMITS;
    const ids = Array.from({ length: contained + 1 }, (_, i) => `n${String(i).padStart(3, "0")}`);
    const vocabulary = [c("top", "Tri"), ...ids.map((id) => c(id, `Tri ${id}`))];
    const pairs = Array.from({ length: together + 1 }, (_, i) => pair(`x${i}`, `y${i}`, 3, 3));
    const out = relationCandidatesOf(vocabulary, none, pairs);
    expect(out.filter((r) => r.kind === "broader")).toHaveLength(contained);
    expect(out.filter((r) => r.kind === "related")).toHaveLength(together);
  });
});
