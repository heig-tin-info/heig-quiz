import { describe, expect, it } from "vitest";

import type { Concept } from "@quiz/contracts";

import { namesAConcept, rankConcepts } from "./ranking";

let seq = 0;
const concept = (
  fr: string,
  en: string | null,
  over: Partial<Pick<Concept, "status" | "qualifiers">> = {},
): Concept => ({
  id: `c0c0c0c0-0000-4000-8000-${String((seq += 1)).padStart(12, "0")}`,
  status: "validated",
  mergedInto: null,
  labels: { fr, en },
  qualifiers: { fr: "", en: "" },
  descriptions: { fr: "", en: "" },
  createdBy: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  ...over,
});

const pointer = concept("Pointeur", "Pointer");
const pointerArithmetic = concept("Arithmétique des pointeurs", "Pointer arithmetic");
const pointers2 = concept("Pointeurs intelligents", "Smart pointers");
const memory = concept("Adresse", "Address", {
  qualifiers: { fr: "mémoire", en: "memory" },
});
const network = concept("Adresse", "Address", {
  qualifiers: { fr: "réseau", en: "network" },
});
const recursion = concept("Récursivité", null, { status: "proposed" });
const array = concept("Tableau", "Array");
const ALL = [pointer, pointerArithmetic, pointers2, memory, network, recursion, array];

const ids = (cs: Concept[]) => cs.map((c) => c.id);

describe("rankConcepts", () => {
  it("keeps an exact match outside the pool above the pool's concepts", () => {
    const ranked = rankConcepts("pointeur", ALL, "fr", new Set([pointerArithmetic.id]));
    expect(ids(ranked).slice(0, 2)).toEqual([pointer.id, pointerArithmetic.id]);
  });

  it("puts the pool's concepts above close and fuzzy matches", () => {
    const ranked = rankConcepts("point", ALL, "fr", new Set([pointers2.id]));
    expect(ranked[0]!.id).toBe(pointers2.id);
  });

  it("lifts a label written with its qualifier to the top", () => {
    const ranked = rankConcepts("adresse (réseau)", ALL, "fr", new Set([memory.id]));
    expect(ranked[0]!.id).toBe(network.id);
  });

  it("lists everything for an empty search, the pool first, then validated before proposed", () => {
    const ranked = rankConcepts("", ALL, "fr", new Set([array.id]));
    expect(ranked[0]!.id).toBe(array.id);
    expect(ranked.at(-1)!.id).toBe(recursion.id);
    expect(ranked).toHaveLength(ALL.length);
  });

  it("orders as before without a pool (the admin's map dialog)", () => {
    expect(ids(rankConcepts("pointeur", ALL, "fr")).slice(0, 1)).toEqual([pointer.id]);
  });
});

describe("namesAConcept", () => {
  it("follows the server's resolution: exact, homonyms, a qualified label, a plural", () => {
    expect(namesAConcept("Pointers", ALL)).toBe(true);
    expect(namesAConcept("adresse", ALL)).toBe(true);
    expect(namesAConcept("adresse (mémoire)", ALL)).toBe(true);
    expect(namesAConcept("adresse (postale)", ALL)).toBe(false);
    expect(namesAConcept("liste chaînée", ALL)).toBe(false);
  });
});
