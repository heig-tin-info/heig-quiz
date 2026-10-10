import { describe, expect, it } from "vitest";

import {
  checkAlias,
  cleanConceptLabel,
  closeConcepts,
  conceptKey,
  editDistance,
  filterIds,
  qualifiedConceptKey,
  resolveConceptLabel,
  splitQualifiedLabel,
  type ResolvableConcept,
} from "./concepts.js";

/**
 * The spelling groups found among the production tags on 2026-10-08 (#599):
 * each group must fold to one key.
 */
const PRODUCTION_GROUPS = [
  ["pointeur", "pointeurs"],
  ["operateurs", "opérateurs"],
  ["chaines", "chaînes"],
  ["conversion", "conversions"],
  ["arithmetique-pointeurs", "arithmétique-de-pointeurs"],
  ["entrées-sorties", "entrees-sorties"],
  ["priorites", "priorite", "priorité"],
  ["incrémentation", "incrementation"],
  ["préprocesseur", "preprocesseur"],
  ["listes-chaînées", "listes-chainees"],
  ["mémoire", "memoire"],
  ["comportement-indefini", "comportement-indéfini"],
  ["compilation-separee", "compilation-séparée"],
  ["portee", "portée"],
  ["pieges", "piege"],
  ["adresse", "adresses"],
  ["declaration", "declarations"],
  ["numération", "numeration"],
  ["cas-limite", "cas-limites"],
  ["ordre-evaluation", "ordre-d-évaluation"],
];

describe("conceptKey", () => {
  it.each(PRODUCTION_GROUPS)(
    "folds the production spellings of %s to one key",
    (...group) => {
      expect(new Set(group.map(conceptKey)).size).toBe(1);
    },
  );

  it("folds case, a leading #, spaces and underscores", () => {
    expect(conceptKey("#Arithmétique de  Pointeurs")).toBe(
      "arithmetique-pointeur",
    );
    expect(conceptKey("virgule_flottante")).toBe("virgule-flottante");
  });

  it("keeps + and # inside a word, so the languages stay apart", () => {
    expect(new Set(["c", "c++", "c#", "#c#"].map(conceptKey))).toEqual(
      new Set(["c", "c++", "c#"]),
    );
    expect(conceptKey("C ++")).toBe("c++");
    expect(conceptKey("directive #include")).toBe(
      conceptKey("directive include"),
    );
  });

  it("spells out the ligatures NFKD keeps", () => {
    expect(new Set(["nœud", "noeud", "Nœuds"].map(conceptKey)).size).toBe(1);
  });

  it("singularizes regular plurals only", () => {
    expect(conceptKey("tableaux")).toBe("tableau");
    expect(conceptKey("tris")).toBe("tri");
    expect(conceptKey("flux")).toBe("flux");
    expect(conceptKey("kiss")).toBe("kiss");
    expect(conceptKey("virus")).toBe("virus");
    expect(conceptKey("bus")).toBe("bus");
    expect(conceptKey("classes")).toBe(conceptKey("class"));
    expect(conceptKey("classe")).toBe(conceptKey("class"));
    expect(conceptKey("processes")).toBe(conceptKey("process"));
    expect(conceptKey("indexes")).toBe(conceptKey("index"));
    expect(conceptKey("axes")).toBe(conceptKey("axe"));
  });

  it("keeps a label made of linking words only", () => {
    expect(conceptKey("de")).toBe("de");
    expect(conceptKey("  ")).toBe("");
  });
});

describe("cleanConceptLabel", () => {
  it("drops the leading # and extra spaces, keeps case and accents", () => {
    expect(cleanConceptLabel("  # Arithmétique   de pointeurs ")).toBe(
      "Arithmétique de pointeurs",
    );
  });
});

describe("editDistance", () => {
  it("counts insertions, deletions, substitutions and adjacent swaps", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("poiner", "pointeur")).toBe(2);
    expect(editDistance("recusrion", "recursion")).toBe(1);
    expect(editDistance("same", "same")).toBe(0);
  });
});

describe("closeConcepts", () => {
  const vocabulary = [
    { id: "ptr", names: ["pointeur", "pointer", "ptr"] },
    { id: "static-c", names: ["static"] },
    { id: "static-cpp", names: ["static-cpp"] },
    { id: "c", names: ["c"] },
    { id: "cpp", names: ["c++"] },
    { id: "tri", names: ["tri"] },
    { id: "trie", names: ["trie"] },
    { id: "rec", names: ["récursivité", "recursion"] },
    { id: "pile", names: ["pile"] },
    { id: "moniteur", names: ["moniteur"] },
    { id: "lecture", names: ["lecture de code"] },
  ];

  it("resolves a spelling variant exactly, through any name of the concept", () => {
    expect(closeConcepts("Pointers", vocabulary)).toEqual([
      { id: "ptr", name: "pointer", kind: "exact", distance: 0 },
    ]);
  });

  it("proposes the concept a typo is close to, never as exact", () => {
    expect(closeConcepts("Poiners", vocabulary)).toEqual([
      { id: "ptr", name: "pointer", kind: "close", distance: 1 },
    ]);
    expect(closeConcepts("recusrion", vocabulary)).toEqual([
      { id: "rec", name: "recursion", kind: "close", distance: 1 },
    ]);
  });

  it("keeps homonyms told apart by a suffix and short keys apart", () => {
    expect(closeConcepts("static", vocabulary).map((m) => m.id)).toEqual([
      "static-c",
    ]);
    expect(closeConcepts("c", vocabulary).map((m) => m.id)).toEqual(["c"]);
    expect(closeConcepts("c++", vocabulary).map((m) => m.id)).toEqual(["cpp"]);
    expect(closeConcepts("tri", vocabulary).map((m) => m.id)).toEqual(["tri"]);
    expect(closeConcepts("tries", vocabulary).map((m) => m.id)).toEqual([
      "trie",
    ]);
  });

  it("does not take a different word of the production tags for a typo", () => {
    expect(closeConcepts("pipe", vocabulary)).toEqual([]);
    expect(closeConcepts("pointeur", vocabulary).map((m) => m.id)).toEqual([
      "ptr",
    ]);
    expect(closeConcepts("écriture de code", vocabulary)).toEqual([]);
  });

  it("ranks exact before close, then by distance, then by name", () => {
    const vocab = [
      { id: "far", names: ["pointeuur"] },
      { id: "b", names: ["pointeurs"] },
      { id: "a", names: ["Pointeur"] },
    ];
    expect(
      closeConcepts("pointeur", vocab).map((m) => [m.id, m.kind, m.distance]),
    ).toEqual([
      ["a", "exact", 0],
      ["b", "exact", 0],
      ["far", "close", 1],
    ]);
  });

  it("returns every homonym when names are bare (ADR-081 §5)", () => {
    const vocab = [
      { id: "memory", names: ["adresse"] },
      { id: "postal", names: ["adresse"] },
    ];
    expect(closeConcepts("adresses", vocab).map((m) => [m.id, m.kind])).toEqual(
      [
        ["memory", "exact"],
        ["postal", "exact"],
      ],
    );
  });

  it.each([
    // [input, name, matches?] — tolerance read on the shorter key
    ["abcd", "abce", false], // 4: none
    ["abcde", "abcdf", true], // 5: one
    ["abcdefgh", "abcdefgi", true], // 8: one
    ["abcdefgh", "abcdefij", false], // 8: not two
    ["abcdefghij", "abcdefghkl", true], // 10: two
    ["abcdefghij", "abcdefgklm", false], // 10: not three
    ["abcdefghijklmnop", "abcdefghijklmxyz", true], // 16: three
    ["abcdefghijklmnopqrst", "abcdefghijklmnopwxyz", false], // 20: three at most
  ])("tolerance: %s ~ %s is %s", (input, name, matches) => {
    expect(closeConcepts(input, [{ id: "x", names: [name] }]).length > 0).toBe(
      matches,
    );
  });

  it("matches nothing for an empty input or a far word", () => {
    expect(closeConcepts("  # ", vocabulary)).toEqual([]);
    expect(closeConcepts("inductance", vocabulary)).toEqual([]);
  });
});

describe("qualifiedConceptKey", () => {
  it("is the label's key without a qualifier", () => {
    expect(qualifiedConceptKey("Pointeurs")).toBe("pointeur");
    expect(qualifiedConceptKey("Pointeurs", "  ")).toBe("pointeur");
  });

  it("appends the qualifier's key after a separator no key contains", () => {
    expect(qualifiedConceptKey("Adresse", "mémoire")).toBe("adress|memoire");
    expect(qualifiedConceptKey("adresses", "Mémoires")).toBe("adress|memoire");
    expect(qualifiedConceptKey("adresse mémoire")).not.toBe(
      qualifiedConceptKey("adresse", "mémoire"),
    );
  });
});

describe("splitQualifiedLabel", () => {
  it("splits a trailing parenthesised qualifier", () => {
    expect(splitQualifiedLabel(" adresse (mémoire) ")).toEqual({
      label: "adresse",
      qualifier: "mémoire",
    });
    expect(splitQualifiedLabel("pile(LIFO)")).toEqual({
      label: "pile",
      qualifier: "LIFO",
    });
  });

  it("is null without one", () => {
    expect(splitQualifiedLabel("adresse")).toBeNull();
    expect(splitQualifiedLabel("(mémoire)")).toBeNull();
    expect(splitQualifiedLabel("adresse ()")).toBeNull();
    expect(splitQualifiedLabel("f(x) + 1")).toBeNull();
  });
});

describe("resolveConceptLabel", () => {
  const concept = (
    id: string,
    labels: [string, string?][],
    aliases: string[] = [],
    mergedInto: string | null = null,
  ): ResolvableConcept => ({
    id,
    mergedInto,
    labels: labels.map(([label, qualifier = ""]) => ({ label, qualifier })),
    aliases,
  });
  const vocabulary = [
    concept("ptr", [["pointeur"], ["pointer"]]),
    concept("mem", [
      ["adresse", "mémoire"],
      ["address", "memory"],
    ]),
    concept("post", [["adresse", "postale"]]),
    concept("ovf", [["dépassement"]], ["overflow"]),
    concept("old", [["pointeurs bruts"]], [], "ptr"),
  ];

  it("filters on what a word designates only: the resolved concept, every homonym, never a close match", () => {
    const ids = (input: string) => filterIds(resolveConceptLabel(input, vocabulary));
    expect(ids("Pointer")).toEqual(["ptr"]);
    expect(ids("old")).toEqual(["ptr"]);
    expect(ids("adresse (postale)")).toEqual(["post"]);
    expect(ids("adresse").sort()).toEqual(["mem", "post"]);
    // A typo has close candidates, which a filter never uses.
    expect(resolveConceptLabel("pointuer", vocabulary)).toMatchObject({ kind: "unknown", candidates: ["ptr"] });
    expect(ids("pointuer")).toEqual([]);
    expect(ids("récursivité")).toEqual([]);
  });

  it("resolves a concept's id, and a merged one's to its final concept", () => {
    expect(resolveConceptLabel("ptr", vocabulary)).toEqual({
      kind: "resolved",
      id: "ptr",
    });
    expect(resolveConceptLabel("old", vocabulary)).toEqual({
      kind: "resolved",
      id: "ptr",
    });
  });

  it("resolves one exact match through a label or an alias, in either language", () => {
    expect(resolveConceptLabel("Pointeurs", vocabulary)).toEqual({
      kind: "resolved",
      id: "ptr",
    });
    expect(resolveConceptLabel("pointers", vocabulary)).toEqual({
      kind: "resolved",
      id: "ptr",
    });
    expect(resolveConceptLabel("Overflow", vocabulary)).toEqual({
      kind: "resolved",
      id: "ovf",
    });
  });

  it("refuses homonyms as ambiguous, and resolves the qualified form", () => {
    expect(resolveConceptLabel("adresse", vocabulary)).toEqual({
      kind: "ambiguous",
      candidates: ["mem", "post"],
    });
    expect(resolveConceptLabel("Adresse (Mémoire)", vocabulary)).toEqual({
      kind: "resolved",
      id: "mem",
    });
    expect(resolveConceptLabel("address (memory)", vocabulary)).toEqual({
      kind: "resolved",
      id: "mem",
    });
  });

  it("is ambiguous when a qualified key is one concept's French and another's English", () => {
    const crossed = [
      concept("fr", [["pile", "lifo"]]),
      concept("en", [["empilement"], ["pile", "LIFO"]]),
    ];
    expect(resolveConceptLabel("pile (LIFO)", crossed)).toEqual({
      kind: "ambiguous",
      candidates: ["fr", "en"],
    });
  });

  it("treats an alias two concepts share as ambiguous", () => {
    const shared = [
      concept("a", [["pile"]], ["stack"]),
      concept("b", [["empilement"]], ["stack"]),
    ];
    expect(resolveConceptLabel("stack", shared)).toEqual({
      kind: "ambiguous",
      candidates: ["a", "b"],
    });
  });

  it("gives close matches as candidates, never as a resolution", () => {
    expect(resolveConceptLabel("Poiners", vocabulary)).toEqual({
      kind: "unknown",
      candidates: ["ptr"],
    });
  });

  it("is unknown without candidates when nothing is near", () => {
    expect(resolveConceptLabel("récursivité", vocabulary)).toEqual({
      kind: "unknown",
      candidates: [],
    });
    expect(resolveConceptLabel("adresse (IP)", vocabulary).kind).toBe(
      "unknown",
    );
    expect(resolveConceptLabel("#", vocabulary)).toEqual({
      kind: "unknown",
      candidates: [],
    });
  });

  it("never matches a merged concept by its labels", () => {
    expect(resolveConceptLabel("pointeurs bruts", vocabulary)).toEqual({
      kind: "unknown",
      candidates: [],
    });
  });

  it("matches a label that really contains parentheses as typed", () => {
    const parens = [concept("lifo", [["pile (LIFO)"]])];
    expect(resolveConceptLabel("Pile (LIFO)", parens)).toEqual({
      kind: "resolved",
      id: "lifo",
    });
  });
});

describe("aliases", () => {
  const concept = (
    id: string,
    labels: string[],
    aliases: string[] = [],
    mergedInto: string | null = null,
  ): ResolvableConcept => ({
    id,
    mergedInto,
    labels: labels.map((label) => ({ label, qualifier: "" })),
    aliases,
  });
  const ovf = concept("ovf", ["dépassement", "overflow"], ["Débordement d'entier"]);
  const ptr = concept("ptr", ["pointeur", "pointer"]);
  const old = concept("old", ["tas"], ["heap"], "ptr");

  it("resolves an alias by its key, spelled any way", () => {
    for (const typed of ["debordement entier", "Débordements d'entiers", "#debordement-d-entier"]) {
      expect(resolveConceptLabel(typed, [ovf, ptr])).toEqual({ kind: "resolved", id: "ovf" });
    }
  });

  it("never resolves through a merged concept's aliases", () => {
    expect(resolveConceptLabel("heap", [ovf, ptr, old])).toEqual({ kind: "unknown", candidates: [] });
  });

  it("is ambiguous when an alias equals another concept's label or alias", () => {
    const clash = concept("clash", ["autre"], ["pointeurs"]);
    expect(resolveConceptLabel("pointeur", [ptr, clash])).toEqual({
      kind: "ambiguous",
      candidates: expect.arrayContaining(["ptr", "clash"]),
    });
  });

  it("checks an alias against the concept itself, then the others", () => {
    const all = [ovf, ptr, old];
    expect(checkAlias("Dépassements", ovf, all)).toEqual({ kind: "redundant", of: "label" });
    expect(checkAlias("debordement entier", ovf, all)).toEqual({ kind: "redundant", of: "alias" });
    expect(checkAlias("pointers", ovf, all)).toEqual({ kind: "collides", with: [{ id: "ptr", via: "label" }] });
    expect(checkAlias("Débordement d'entier", ptr, all)).toEqual({
      kind: "collides",
      with: [{ id: "ovf", via: "alias" }],
    });
    expect(checkAlias("heap", ptr, all)).toEqual({ kind: "free" });
  });
});
