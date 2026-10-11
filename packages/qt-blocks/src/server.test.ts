import { describe, expect, it } from "vitest";

import type { GradedResult } from "@quiz/core/server";
import { testGradeContext } from "@quiz/core/testing";
import type { Stmt } from "@quiz/domain/blocks";

import type { BlocksAnswer, BlocksConfig, BlocksDetails } from "./schema.js";
import { blocksServer } from "./server.js";
import { SECRET_CONFIG } from "./testing.js";

function grade(config: BlocksConfig, answer: BlocksAnswer | null, points = 7): GradedResult<BlocksDetails> {
  const result = blocksServer.grade(config, answer, testGradeContext(points));
  if (result instanceof Promise || result.kind !== "graded") throw new Error("expected a synchronous grade");
  return result;
}

const REFERENCE = SECRET_CONFIG.referenceSolution!;
/** Straight ahead, seven cells: the first warehouse only. */
const SEVEN: Stmt[] = [{ kind: "repeat", times: 7, body: [{ kind: "forward" }] }];

describe("grade", () => {
  it("gives every point to a program that reaches every dock, validated", () => {
    const { points, maxPoints, state, details } = grade(SECRET_CONFIG, { program: REFERENCE });
    expect({ points, maxPoints, state }).toEqual({ points: 7, maxPoints: 7, state: "validated" });
    expect(details.cases.every((c) => c.ok && c.reason === "dock")).toBe(true);
    expect(details).toMatchObject({ earned: 7, total: 7 });
    expect(details.cases[0]).toEqual({
      name: "Clear aisle",
      visible: true,
      points: 1,
      ok: true,
      reason: "dock",
      moves: 7,
      trail: Array.from({ length: 8 }, (_, x) => ({ x, y: 2 })),
    });
  });

  it("sums the points of the warehouses reached, on the item's scale", () => {
    const { points, details } = grade(SECRET_CONFIG, { program: SEVEN }, 14);
    expect(details.cases.map((c) => c.ok)).toEqual([true, false, false, false]);
    expect(details.cases.map((c) => c.reason)).toEqual(["dock", "collision", "collision", "collision"]);
    expect(details).toMatchObject({ earned: 1, total: 7 });
    expect(points).toBe(2);
  });

  it("gives nothing short of every warehouse under all or nothing", () => {
    expect(grade({ ...SECRET_CONFIG, allOrNothing: true }, { program: SEVEN }).points).toBe(0);
    expect(grade({ ...SECRET_CONFIG, allOrNothing: true }, { program: REFERENCE }).points).toBe(7);
  });

  it("gives nothing to no answer, and runs the empty program for its details", () => {
    const { points, details } = grade(SECRET_CONFIG, null);
    expect(points).toBe(0);
    expect(details.cases.every((c) => c.reason === "short" && c.moves === 0)).toBe(true);
  });

  it("defends itself against a block the toolbox does not offer", () => {
    const narrow = { ...SECRET_CONFIG, toolbox: ["forward", "repeat"] as BlocksConfig["toolbox"], referenceSolution: null };
    const result = grade(narrow, { program: [{ kind: "turn", dir: "left" }, ...SEVEN] });
    expect(result.points).toBe(0);
    expect(result.comment).toBe("blocks.answer_misfit");
    expect(grade(narrow, { program: SEVEN }).comment).toBeUndefined();
  });

  it("is worth nothing when every warehouse is worth nothing", () => {
    const free = { ...SECRET_CONFIG, cases: SECRET_CONFIG.cases.map((c) => ({ ...c, points: 0 })) };
    expect(grade(free, { program: REFERENCE }).points).toBe(0);
    expect(blocksServer.defaultPoints(free)).toBe(1);
    expect(blocksServer.defaultPoints(SECRET_CONFIG)).toBe(7);
  });
});

describe("publicationIssues", () => {
  it("passes a reference that reaches every dock, hidden ones included", () => {
    expect(blocksServer.publicationIssues!(SECRET_CONFIG)).toEqual([]);
  });

  it("refuses a missing reference, null or empty (ADR-103 §3)", () => {
    for (const referenceSolution of [null, []]) {
      expect(blocksServer.publicationIssues!({ ...SECRET_CONFIG, referenceSolution })).toEqual([
        { path: ["referenceSolution"], message: "blocks.reference_missing" },
      ]);
    }
  });

  it("names every warehouse the reference misses, hidden ones too", () => {
    expect(blocksServer.publicationIssues!({ ...SECRET_CONFIG, referenceSolution: SEVEN })).toEqual([
      { path: ["cases", 1], message: "blocks.reference_fails_case" },
      { path: ["cases", 2], message: "blocks.reference_fails_case" },
      { path: ["cases", 3], message: "blocks.reference_fails_case" },
    ]);
  });
});

describe("the other hooks", () => {
  it("is never shuffled", () => {
    expect(blocksServer.shuffleable(SECRET_CONFIG)).toBe(false);
  });

  it("refuses an answer with a block the toolbox does not offer", () => {
    const narrow = { ...SECRET_CONFIG, toolbox: ["forward", "repeat"] as BlocksConfig["toolbox"] };
    expect(blocksServer.answerMisfit!(narrow, { program: SEVEN })).toBeNull();
    expect(blocksServer.answerMisfit!(narrow, { program: REFERENCE })).toBe("blocks.answer_misfit");
  });

  it("summarises an answer by its size, never its worth", () => {
    expect(blocksServer.summarizeAnswer!(SECRET_CONFIG, { program: REFERENCE })).toBe("4 blocks");
    expect(blocksServer.summarizeAnswer!(SECRET_CONFIG, { program: [{ kind: "forward" }] })).toBe("1 block");
  });

  it("counts the pass rate of the visible warehouses, skipping what it cannot read", () => {
    const passed = grade(SECRET_CONFIG, { program: REFERENCE }).details;
    const partial = grade(SECRET_CONFIG, { program: SEVEN }).details;
    expect(blocksServer.aggregate!({ answers: [], details: [passed, partial, { junk: true }] })).toEqual({
      casePassRate: [
        { name: "Clear aisle", passed: 2, total: 2 },
        { name: "Rack on the aisle", passed: 1, total: 2 },
      ],
    });
  });

  it("gives the key: the reference and every warehouse (D17)", () => {
    const solution = blocksServer.toSolution(SECRET_CONFIG, { seed: 0, itemId: "i", shuffle: false });
    expect(solution.referenceSolution).toEqual(REFERENCE);
    expect(solution.cases.map((c) => [c.name, c.visible])).toEqual([
      ["Clear aisle", true],
      ["Rack on the aisle", true],
      ["Hidden north-east", false],
      ["Trapped corridor", false],
    ]);
    expect(blocksServer.solutionSchema.safeParse(solution).success).toBe(true);
  });

  it("indexes the statement and the warehouses' names", () => {
    expect(blocksServer.searchText(SECRET_CONFIG)).toContain("Trapped corridor");
    expect(blocksServer.searchText(SECRET_CONFIG)).toContain("Bring the robot");
  });

  it("migrates its own version by identity and refuses a newer one", () => {
    expect(blocksServer.migrate(SECRET_CONFIG, 1)).toBe(SECRET_CONFIG);
    expect(() => blocksServer.migrate(SECRET_CONFIG, 2)).toThrow();
  });
});
