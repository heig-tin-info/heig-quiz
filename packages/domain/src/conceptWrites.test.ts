import { describe, expect, it } from "vitest";

import type { ResolvableConcept } from "./concepts.js";
import {
  conceptLabelIn,
  conceptToCreate,
  droppedReason,
  planConceptWrite,
} from "./conceptWrites.js";

const concept = (
  id: string,
  labels: [string, string?][],
  mergedInto: string | null = null,
): ResolvableConcept => ({
  id,
  mergedInto,
  labels: labels.map(([label, qualifier = ""]) => ({ label, qualifier })),
});

const vocabulary = [
  concept("ptr", [["pointeur"], ["pointer"]]),
  concept("mem", [["adresse", "mémoire"]]),
  concept("post", [["adresse", "postale"]]),
  concept("old", [["pointeur ancien"]], "ptr"),
  concept("rec", [["récursion"]]),
];

/** The stop list: the keys of the tags the admin dropped, with the reason. */
const dropped = new Map([
  ["c01", "organisational"],
  ["lecture-code", "task_kind"],
  ["prog-c", "organisational"],
]);

const plan = (inputs: string[], create = false) =>
  planConceptWrite(inputs, vocabulary, { create, dropped });

describe("planConceptWrite", () => {
  it("resolves an id, a merged id to its final concept, a qualified label and one exact match", () => {
    expect(plan(["ptr", "old", "adresse (mémoire)", "Pointers"])).toEqual({
      kind: "ok",
      targets: [
        { kind: "existing", id: "ptr" },
        { kind: "existing", id: "ptr" },
        { kind: "existing", id: "mem" },
        { kind: "existing", id: "ptr" },
      ],
      creates: [],
    });
  });

  it("refuses several exact matches, even when creation is asked", () => {
    for (const create of [false, true]) {
      expect(plan(["adresse"], create)).toEqual({
        kind: "refused",
        errors: [
          {
            input: "adresse",
            error: "concept_ambiguous",
            candidates: ["mem", "post"],
          },
        ],
      });
    }
  });

  it("refuses a close match only, with the candidates, unless creation is asked", () => {
    expect(plan(["recursoin"])).toEqual({
      kind: "refused",
      errors: [
        { input: "recursoin", error: "concept_unknown", candidates: ["rec"] },
      ],
    });
    expect(plan(["recursoin"], true)).toMatchObject({
      kind: "ok",
      targets: [{ kind: "new", index: 0 }],
    });
  });

  it("refuses an unknown label without candidates when creation is not asked", () => {
    expect(plan(["boucle"])).toEqual({
      kind: "refused",
      errors: [{ input: "boucle", error: "concept_unknown", candidates: [] }],
    });
  });

  it("creates an unknown label, with its qualifier, once per key", () => {
    expect(plan(["# Boucle ", "boucles", "pile (structure)"], true)).toEqual({
      kind: "ok",
      targets: [
        { kind: "new", index: 0 },
        { kind: "new", index: 0 },
        { kind: "new", index: 1 },
      ],
      creates: [
        { label: "Boucle", qualifier: "", key: "boucle" },
        { label: "pile", qualifier: "structure", key: "pile|structure" },
      ],
    });
  });

  it("refuses to create a dropped tag's key, unless a qualifier tells it apart", () => {
    expect(plan(["C01", "Lecture de code", "c01 (cours)", "prog (c)"], true)).toEqual({
      kind: "refused",
      errors: [
        { input: "C01", error: "concept_dropped", reason: "organisational" },
        {
          input: "Lecture de code",
          error: "concept_dropped",
          reason: "task_kind",
        },
      ],
    });
    expect(plan(["c01 (cours)"], true)).toMatchObject({
      kind: "ok",
      creates: [{ label: "c01", qualifier: "cours" }],
    });
  });

  it("lets an existing concept resolve though its key is dropped", () => {
    const withC01 = [...vocabulary, concept("c01", [["C01"]])];
    expect(
      planConceptWrite(["c01"], withC01, { create: false, dropped }),
    ).toEqual({
      kind: "ok",
      targets: [{ kind: "existing", id: "c01" }],
      creates: [],
    });
  });

  it("is all or nothing: one bad input refuses the batch, every error listed", () => {
    expect(plan(["ptr", "boucle", "adresse", "nouveau"])).toEqual({
      kind: "refused",
      errors: [
        { input: "boucle", error: "concept_unknown", candidates: [] },
        {
          input: "adresse",
          error: "concept_ambiguous",
          candidates: ["mem", "post"],
        },
        { input: "nouveau", error: "concept_unknown", candidates: [] },
      ],
    });
  });

  it("refuses to create from an input with no letter nor digit", () => {
    expect(plan(["---"], true)).toEqual({
      kind: "refused",
      errors: [{ input: "---", error: "concept_unknown", candidates: [] }],
    });
  });
});

describe("conceptToCreate", () => {
  it("rejects a label over the bound", () => {
    expect(conceptToCreate("x".repeat(121))).toBeNull();
    expect(conceptToCreate(`x (${"q".repeat(121)})`)).toBeNull();
    expect(conceptToCreate("x".repeat(120))).toMatchObject({
      label: "x".repeat(120),
    });
  });
});

describe("droppedReason", () => {
  it("names the reason of a dropped key, null otherwise", () => {
    expect(droppedReason("Prog C", "", dropped)).toBe("organisational");
    expect(droppedReason("Prog C", "langage", dropped)).toBeNull();
    expect(droppedReason("pointeur", "", dropped)).toBeNull();
  });
});

describe("conceptLabelIn", () => {
  const sides = {
    fr: { label: "adresse", qualifier: "mémoire" },
    en: { label: null, qualifier: "" },
  };

  it("shows the reader's language, else the other's, with its qualifier", () => {
    expect(conceptLabelIn(sides, "fr")).toEqual({
      label: "adresse",
      qualifier: "mémoire",
    });
    expect(
      conceptLabelIn(
        {
          fr: { label: null, qualifier: "" },
          en: { label: "loop", qualifier: "" },
        },
        "fr",
      ),
    ).toEqual({ label: "loop", qualifier: "" });
    expect(conceptLabelIn(sides, "en")).toEqual({
      label: "adresse",
      qualifier: "mémoire",
    });
    expect(
      conceptLabelIn(
        { fr: sides.fr, en: { label: "address", qualifier: "memory" } },
        "en",
      ),
    ).toEqual({ label: "address", qualifier: "memory" });
  });
});
