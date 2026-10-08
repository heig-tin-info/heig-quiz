import { describe, expect, it } from "vitest";

import { groupTagsByConceptKey } from "./concepts.js";
import {
  batchTagGroups,
  readSortReply,
  type SortRegistryConcept,
  type SortReplyConcept,
  type SortNewConcept,
  type SortVerdict,
} from "./conceptSorting.js";

const REASONS = ["organisational", "task_kind", "noise"] as const;

describe("batchTagGroups", () => {
  const pairs = (tag: string, pools: number) =>
    Array.from({ length: pools }, (_, i) => ({
      poolId: `p${i}`,
      tag,
      count: 1,
    }));
  const groups = groupTagsByConceptKey([
    ...pairs("alpha", 3),
    ...pairs("beta", 1),
    ...pairs("gamma", 2),
    ...pairs("delta", 1),
  ]);

  it("cuts by groups, keeping the order", () => {
    const batches = batchTagGroups(groups, { groups: 2, pairs: 100 });
    expect(batches.map((b) => b.map((g) => g.key))).toEqual([
      ["alpha", "gamma"],
      ["beta", "delta"],
    ]);
  });

  it("cuts by pairs, never splitting a group, a large one alone", () => {
    const batches = batchTagGroups(groups, { groups: 10, pairs: 2 });
    expect(batches.map((b) => b.map((g) => g.key))).toEqual([
      ["alpha"],
      ["gamma"],
      ["beta", "delta"],
    ]);
  });

  it("gives no batch for no group", () => {
    expect(batchTagGroups([], { groups: 3, pairs: 3 })).toEqual([]);
  });
});

describe("readSortReply", () => {
  const side = (label: string, description = "") => ({
    label,
    qualifier: "",
    description,
  });
  const registry = new Map<string, SortRegistryConcept>([
    [
      "c1",
      {
        id: "id-pointer",
        sides: {
          fr: { label: "Pointeur", qualifier: "" },
          en: { label: "Pointer", qualifier: "" },
        },
      },
    ],
    [
      "c2",
      {
        id: "id-loop",
        sides: { fr: { label: "Boucle", qualifier: "" }, en: null },
      },
    ],
  ]);
  const verdict = (id: string, v: Partial<SortVerdict>): SortVerdict => ({
    id,
    concept: null,
    drop: null,
    broader: null,
    note: null,
    ...v,
  });
  const read = (
    proposed: Map<string, SortNewConcept>,
    verdicts: SortVerdict[],
    newConcepts: SortReplyConcept[] = [],
    pairs = ["p1", "p2", "p3", "p4"],
  ) =>
    readSortReply({
      pairs: new Set(pairs),
      registry,
      proposed,
      dropReasons: REASONS,
      verdicts,
      newConcepts,
    });

  it("maps a registry handle to its id, a drop to its reason, with the hints", () => {
    const out = read(new Map(), [
      verdict("p1", {
        concept: "c1",
        broader: " Mémoire ",
        note: "an address",
      }),
      verdict("p2", { drop: "task_kind" }),
    ]);
    expect(out.get("p1")).toEqual({
      kind: "concept",
      conceptId: "id-pointer",
      broader: "Mémoire",
      note: "an address",
    });
    expect(out.get("p2")).toEqual({ kind: "drop", dropReason: "task_kind" });
  });

  it("gives no proposal for an unknown handle, an unknown reason, both or neither, an unknown pair, a second answer", () => {
    const out = read(new Map(), [
      verdict("p1", { concept: "c9" }),
      verdict("p2", { drop: "boring" }),
      verdict("p3", { concept: "c1", drop: "noise" }),
      verdict("p4", {}),
      verdict("p5", { concept: "c1" }),
    ]);
    expect(out.size).toBe(0);
    const twice = read(new Map(), [
      verdict("p1", { concept: "c1" }),
      verdict("p1", { drop: "noise" }),
    ]);
    expect(twice.get("p1")).toEqual({
      kind: "concept",
      conceptId: "id-pointer",
    });
  });

  it("proposes a new concept once, under a run handle, cleaned; an invalid one gives nothing", () => {
    const proposed = new Map<string, SortNewConcept>();
    const out = read(
      proposed,
      [
        verdict("p1", { concept: "x1" }),
        verdict("p2", { concept: "x1" }),
        verdict("p3", { concept: "x2" }),
      ],
      [
        {
          id: "x1",
          fr: side("  #Récursivité ", "Une fonction qui s'appelle."),
          en: side("Recursion"),
        },
        { id: "x2", fr: side("—"), en: side("Dash") },
      ],
    );
    const recursion = {
      fr: side("Récursivité", "Une fonction qui s'appelle."),
      en: side("Recursion"),
    };
    expect(out.get("p1")).toEqual({ kind: "new", newConcept: recursion });
    expect(out.get("p2")).toEqual({ kind: "new", newConcept: recursion });
    expect(out.has("p3")).toBe(false);
    expect([...proposed]).toEqual([["n1", recursion]]);
  });

  it("maps a new concept onto the registry concept that holds one of its keys", () => {
    const proposed = new Map<string, SortNewConcept>();
    const out = read(
      proposed,
      [verdict("p1", { concept: "x1" })],
      [{ id: "x1", fr: side("Boucles"), en: side("Loop") }],
    );
    expect(out.get("p1")).toEqual({ kind: "concept", conceptId: "id-loop" });
    expect(proposed.size).toBe(0);
  });

  it("lets a later batch map onto an earlier new concept, by handle or by key, with the same labels", () => {
    const proposed = new Map<string, SortNewConcept>();
    read(
      proposed,
      [verdict("p1", { concept: "x1" })],
      [{ id: "x1", fr: side("Pile"), en: side("Stack") }],
    );
    const first = proposed.get("n1")!;
    const later = read(
      proposed,
      [verdict("p2", { concept: "n1" }), verdict("p3", { concept: "x1" })],
      [
        {
          id: "x1",
          fr: side("Piles", "Autre description"),
          en: side("Stacks"),
        },
      ],
    );
    expect(later.get("p2")).toEqual({ kind: "new", newConcept: first });
    expect(later.get("p3")).toEqual({ kind: "new", newConcept: first });
    expect(proposed.size).toBe(1);
  });

  it("gives nothing for an id of the answer's own that reuses a received handle", () => {
    const proposed = new Map<string, SortNewConcept>([
      ["n1", { fr: side("Pile"), en: side("Stack") }],
    ]);
    const out = read(
      proposed,
      [
        verdict("p1", { concept: "c1" }),
        verdict("p2", { concept: "n1" }),
        verdict("p3", { concept: "x1" }),
      ],
      [
        { id: "c1", fr: side("Tas"), en: side("Heap") },
        { id: "n1", fr: side("File"), en: side("Queue") },
        { id: "x1", fr: side("Arbre"), en: side("Tree") },
      ],
    );
    expect(out.has("p1")).toBe(false);
    expect(out.has("p2")).toBe(false);
    expect(out.get("p3")).toMatchObject({ kind: "new" });
    expect([...proposed.keys()]).toEqual(["n1", "n2"]);
  });

  it("never reads an id of the answer as a run handle created while reading it", () => {
    const proposed = new Map<string, SortNewConcept>([
      ["n1", { fr: side("Pile"), en: side("Stack") }],
    ]);
    const out = read(
      proposed,
      [verdict("p1", { concept: "x1" }), verdict("p2", { concept: "n2" })],
      [
        { id: "x1", fr: side("Arbre"), en: side("Tree") },
        { id: "n2", fr: side("Graphe"), en: side("Graph") },
      ],
    );
    expect(out.get("p1")).toMatchObject({
      newConcept: { en: { label: "Tree" } },
    });
    expect(out.get("p2")).toMatchObject({
      newConcept: { en: { label: "Graph" } },
    });
    expect([...proposed.keys()]).toEqual(["n1", "n2", "n3"]);
  });
});
