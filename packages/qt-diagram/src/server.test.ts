import { describe, expect, it } from "vitest";
import { emptyScene, sameScene, type Scene } from "@quiz/diagram/server";

import { config, gradeContext, REFERENCE, STARTER } from "./test/fixtures.js";
import { diagramServer } from "./server.js";

const answer = (scene: Scene) => ({ scene });
const drawn: Scene = {
  nodes: [...STARTER.nodes, { id: "stud0001", t: "class", x: 40, y: 240, name: "Circle" }],
  links: [{ id: "stud0002", type: "inh", a: "stud0001", b: "st4rt001" }],
};

describe("publicationIssues", () => {
  it("accepts a complete question", () => {
    expect(diagramServer.publicationIssues?.(config())).toEqual([]);
  });

  it("refuses a question without a reference", () => {
    expect(diagramServer.publicationIssues?.(config({ reference: emptyScene() }))).toEqual([
      { path: ["reference"], message: "diagram.reference_missing" },
    ]);
  });

  it("refuses a reference or a starter holding what the kind does not have", () => {
    // A class diagram and its starter, read as a state machine.
    expect(diagramServer.publicationIssues?.(config({ kind: "state" }))).toEqual([
      { path: ["reference"], message: "diagram.kind_mismatch" },
      { path: ["starter"], message: "diagram.kind_mismatch" },
    ]);
  });

  it("accepts a question without a starter", () => {
    const { starter: _drop, ...bare } = config();
    expect(diagramServer.publicationIssues?.(bare)).toEqual([]);
  });
});

describe("answerMisfit", () => {
  it("accepts an answer drawn with the kind's tools", () => {
    expect(diagramServer.answerMisfit?.(config(), answer(drawn))).toBeNull();
  });

  it("refuses an element of another kind", () => {
    const state: Scene = { nodes: [{ id: "abcd1234", t: "state", x: 0, y: 0, name: "Idle" }], links: [] };
    expect(diagramServer.answerMisfit?.(config(), answer(state))).toBe("diagram.answer_misfit");
  });

  it("refuses a link of another kind", () => {
    const scene: Scene = { ...drawn, links: [{ id: "stud0002", type: "trans", a: "stud0001", b: "st4rt001" }] };
    expect(diagramServer.answerMisfit?.(config(), answer(scene))).toBe("diagram.answer_misfit");
  });

  it("refuses more elements than a structured kind allows", () => {
    const nodes = Array.from({ length: 81 }, (_, i) => ({ id: `n${String(i).padStart(4, "0")}`, t: "class" as const, x: 0, y: i * 20 }));
    expect(diagramServer.answerSchema.safeParse(answer({ nodes, links: [] })).success).toBe(true);
    expect(diagramServer.answerMisfit?.(config(), answer({ nodes, links: [] }))).toBe("diagram.answer_misfit");
  });
});

describe("grade", () => {
  const ctx = gradeContext(3);

  it("validates 0 for no answer", async () => {
    expect(await diagramServer.grade(config(), null, ctx)).toEqual({
      kind: "graded",
      points: 0,
      maxPoints: 3,
      details: { reason: "empty", nodes: 0, links: 0 },
    });
  });

  it("validates 0 for an empty scene", async () => {
    const { starter: _drop, ...bare } = config();
    expect(await diagramServer.grade(bare, answer(emptyScene()), ctx)).toMatchObject({ points: 0, details: { reason: "empty" } });
  });

  it("validates 0 for the untouched starter, whatever order its keys come in", async () => {
    const reordered: Scene = { nodes: [{ name: "Shape", y: 40, x: 40, t: "class", id: "st4rt001" }], links: [] };
    const result = await diagramServer.grade(config(), answer(reordered), ctx);
    expect(result).toEqual({ kind: "graded", points: 0, maxPoints: 3, details: { reason: "empty", nodes: 1, links: 0 } });
    expect("state" in result).toBe(false);
  });

  it("proposes 0 for a drawn answer, for the teacher to settle", async () => {
    expect(await diagramServer.grade(config(), answer(drawn), ctx)).toEqual({
      kind: "graded",
      points: 0,
      maxPoints: 3,
      details: { reason: "manual", nodes: 2, links: 1 },
      state: "proposed",
    });
  });

  it("proposes 0, never an empty grade, for an answer drawn for another kind (a regrade on a newer version)", async () => {
    const result = await diagramServer.grade(config({ kind: "state", starter: undefined, reference: { nodes: [{ id: "st000001", t: "state", x: 0, y: 0, name: "Idle" }], links: [] } }), answer(drawn), ctx);
    expect(result).toEqual({
      kind: "graded",
      points: 0,
      maxPoints: 3,
      details: { reason: "kind_mismatch", nodes: 2, links: 1 },
      state: "proposed",
    });
  });

  it("proposes 0 for the reference itself: v1 grades by hand", async () => {
    expect(await diagramServer.grade(config(), answer(REFERENCE), ctx)).toMatchObject({ state: "proposed", details: { reason: "manual" } });
  });
});

describe("the rest of the contract", () => {
  it("counts an answer as answered as soon as its scene holds something", () => {
    expect(diagramServer.isAnswered(answer(emptyScene()))).toBe(false);
    expect(diagramServer.isAnswered(answer(STARTER))).toBe(true);
  });

  it("proposes 1 point, shuffles nothing, and summarises in figures", () => {
    expect(diagramServer.defaultPoints(config())).toBe(1);
    expect(diagramServer.shuffleable(config())).toBe(false);
    expect(diagramServer.summarizeAnswer?.(config(), answer(drawn))).toBe("2 · 1");
  });

  it("indexes the prompt, the rubric and the reference's names for the teacher's search", () => {
    const text = diagramServer.searchText(config());
    expect(text).toContain("figures");
    expect(text).toContain("RUBRIC-SECRET");
    expect(text).toContain("SecretCircleRef");
  });

  it("migrates its own version and refuses another", () => {
    expect(diagramServer.migrate(config(), 1)).toEqual(config());
    expect(() => diagramServer.migrate(config(), 0)).toThrow();
  });
});

describe("sameScene (the engine's, read by grade)", () => {
  it("tells an edit from the starter", () => {
    expect(sameScene(STARTER, structuredClone(STARTER))).toBe(true);
    expect(sameScene(STARTER, { ...STARTER, nodes: [{ ...STARTER.nodes[0]!, x: 60 }] })).toBe(false);
  });
});
