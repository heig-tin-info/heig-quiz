import { describe, expect, it } from "vitest";
import { MAX_TEXT } from "@quiz/diagram/server";

import { DiagramAnswerSchema, DiagramConfigSchema, emptyDiagramDraft, isDiagramAnswered } from "./schema.js";
import { config, REFERENCE } from "./test/fixtures.js";

describe("DiagramConfigSchema", () => {
  it("parses a complete question and defaults the rubric", () => {
    const { rubric: _drop, ...noRubric } = config();
    expect(DiagramConfigSchema.parse(noRubric).rubric).toBe("");
  });

  it("refuses an unknown kind and an empty prompt", () => {
    expect(DiagramConfigSchema.safeParse({ ...config(), kind: "drawing" }).success).toBe(false);
    expect(DiagramConfigSchema.safeParse({ ...config(), prompt: "" }).success).toBe(false);
  });

  it("stores a draft without a reference: publication is the gate", () => {
    expect(DiagramConfigSchema.safeParse({ ...emptyDiagramDraft(), prompt: "x" }).success).toBe(true);
  });

  it("gives an empty draft that is empty, not pre-filled", () => {
    expect(emptyDiagramDraft()).toEqual({
      configVersion: 1,
      prompt: "",
      kind: "class",
      reference: { nodes: [], links: [] },
      rubric: "",
    });
  });
});

describe("DiagramAnswerSchema", () => {
  it("takes a scene and nothing else", () => {
    expect(DiagramAnswerSchema.safeParse({ scene: REFERENCE }).success).toBe(true);
    expect(DiagramAnswerSchema.safeParse({ scene: REFERENCE, text: "class A" }).success).toBe(false);
  });

  it("enforces the engine's limits: text, control characters, dangling links", () => {
    const long = "x".repeat(200);
    const nodes = Array.from({ length: 80 }, (_, i) => ({
      id: `n${String(i).padStart(4, "0")}`,
      t: "class" as const,
      x: 0,
      y: 0,
      body: Array.from({ length: 40 }, () => long),
    }));
    expect(80 * 40 * 200).toBeGreaterThan(MAX_TEXT);
    expect(DiagramAnswerSchema.safeParse({ scene: { nodes, links: [] } }).success).toBe(false);
    const forged = { nodes: [{ id: "abcd1234", t: "class", x: 0, y: 0, name: "A\nclass B" }], links: [] };
    expect(DiagramAnswerSchema.safeParse({ scene: forged }).success).toBe(false);
    const dangling = { nodes: [], links: [{ id: "abcd1234", type: "assoc", a: "zzzz0000", b: "yyyy0000" }] };
    expect(DiagramAnswerSchema.safeParse({ scene: dangling }).success).toBe(false);
  });
});

describe("isDiagramAnswered", () => {
  it("is a scene that holds something", () => {
    expect(isDiagramAnswered({ scene: { nodes: [], links: [] } })).toBe(false);
    expect(isDiagramAnswered({ scene: REFERENCE })).toBe(true);
  });
});
