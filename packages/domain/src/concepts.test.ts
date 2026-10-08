import { describe, expect, it } from "vitest";

import {
  cleanConceptLabel,
  closeConcepts,
  conceptKey,
  editDistance,
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
