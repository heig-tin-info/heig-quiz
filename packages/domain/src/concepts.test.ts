import { describe, expect, it } from "vitest";

import {
  cleanConceptLabel,
  closeConcepts,
  conceptKey,
  editDistance,
  groupNewConcepts,
  groupTagsByConceptKey,
  qualifiedConceptKey,
  resolveConceptLabel,
  splitQualifiedLabel,
  tagGroupKey,
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

describe("groupTagsByConceptKey", () => {
  it("groups the spellings of one key across pools, most worn first", () => {
    const groups = groupTagsByConceptKey([
      { poolId: "p2", tag: "boucle", count: 9 },
      { poolId: "p1", tag: "pointeur", count: 3 },
      { poolId: "p2", tag: "Pointeurs", count: 4 },
      { poolId: "p1", tag: "pointeurs", count: 4 },
      { poolId: "p1", tag: "c++", count: 1 },
      { poolId: "p1", tag: "c", count: 1 },
    ]);
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ["pointeur", 11],
      ["boucle", 9],
      ["c", 1],
      ["c++", 1],
    ]);
    expect(groups[0]!.pairs.map((p) => `${p.poolId}:${p.tag}`)).toEqual([
      "p2:Pointeurs",
      "p1:pointeurs",
      "p1:pointeur",
    ]);
  });

  it("keeps the caller's fields and does not depend on the input order", () => {
    const rows = [
      { poolId: "b", tag: "pile", count: 2, extra: 1 },
      { poolId: "a", tag: "pile", count: 2, extra: 2 },
      { poolId: "a", tag: "piles", count: 5, extra: 3 },
    ];
    const once = groupTagsByConceptKey(rows);
    expect(groupTagsByConceptKey([...rows].reverse())).toEqual(once);
    expect(once[0]!.pairs.map((p) => p.extra)).toEqual([3, 2, 1]);
  });

  it("keys a tag with no letter nor digit by itself", () => {
    expect(tagGroupKey("???")).toBe("???");
    expect(tagGroupKey("Pointeurs")).toBe("pointeur");
    expect(groupTagsByConceptKey([])).toEqual([]);
  });
});

describe("groupNewConcepts", () => {
  const pointer = {
    fr: { label: " Pointeur ", description: "" },
    en: { label: "Pointer" },
  };

  it("makes one concept of the requests with the same keys, the first description per language kept", () => {
    const grouping = groupNewConcepts([
      { item: 1, ...pointer },
      {
        item: 2,
        fr: { label: "pointeurs", description: "Une adresse." },
        en: { label: "pointers", description: "An address." },
      },
      {
        item: 3,
        fr: { label: "adresse", qualifier: "  mémoire  vive " },
        en: { label: "address" },
      },
    ]);
    expect(grouping).toEqual({
      kind: "ok",
      concepts: [
        {
          items: [1, 2],
          sides: {
            fr: {
              label: "Pointeur",
              qualifier: "",
              description: "Une adresse.",
              key: "pointeur",
            },
            en: {
              label: "Pointer",
              qualifier: "",
              description: "An address.",
              key: "pointer",
            },
          },
        },
        {
          items: [3],
          sides: {
            fr: {
              label: "adresse",
              qualifier: "mémoire vive",
              description: "",
              key: "adress|memoire-vive",
            },
            en: {
              label: "address",
              qualifier: "",
              description: "",
              key: "address",
            },
          },
        },
      ],
    });
  });

  it("names every item of two concepts that share one language's key only", () => {
    expect(
      groupNewConcepts([
        { item: "a", ...pointer },
        { item: "b", fr: { label: "boucle" }, en: { label: "loop" } },
        { item: "c", fr: { label: "pointeurs" }, en: { label: "Address" } },
        { item: "d", ...pointer },
      ]),
    ).toEqual({ kind: "clash", items: ["a", "d", "c"] });
  });
});
