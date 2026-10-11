/**
 * Our syntax tree through a Blockly workspace and back (ADR-103 §5), and the
 * JavaScript of the Code tab — headless, under Node, with the bundle's own
 * block definitions.
 */
import { describe, expect, it } from "vitest";

import type { Stmt } from "@quiz/domain/blocks";

import { blockAt, headless, roundTrip, workspaceState } from "./blocklyBundle.js";
import { runCase } from "./grade.js";
import { blocksCanvasStrings } from "./strings.js";
import { SECRET_CONFIG } from "./testing.js";

const EVERY_KIND: Stmt[] = [
  { kind: "forward" },
  { kind: "turn", dir: "left" },
  { kind: "repeat", times: 3, body: [{ kind: "forward" }, { kind: "turn", dir: "right" }] },
  {
    kind: "repeat_until_dock",
    body: [
      {
        kind: "if_sensor",
        sensor: "blocked",
        where: "left",
        then: [{ kind: "turn", dir: "right" }],
        else: [],
      },
    ],
  },
];

describe("the workspace conversions", () => {
  it.each([
    ["the empty program", []],
    ["every kind, nested", EVERY_KIND],
    ["the reference of the fixture", SECRET_CONFIG.referenceSolution!],
    ["the starter of the fixture", SECRET_CONFIG.starter],
  ])("give back %s unchanged", (_name, program) => {
    expect(roundTrip(program as Stmt[], blocksCanvasStrings).program).toEqual(program);
  });

  it("lays the stack under one undeletable, unmovable hat", () => {
    const state = workspaceState([{ kind: "forward" }]) as { blocks: { blocks: Record<string, unknown>[] } };
    expect(state.blocks.blocks).toHaveLength(1);
    expect(state.blocks.blocks[0]).toMatchObject({ type: "start", deletable: false, movable: false, next: { block: { type: "forward" } } });
  });

  it("labels the blocks in the reader's words, wherever the translation puts a field", () => {
    const french = { ...blocksCanvasStrings, ifSensor: "si {where} est {sensor}" };
    expect(roundTrip(EVERY_KIND, french).program).toEqual(EVERY_KIND);
  });
});

describe("blockAt: the block a run event names", () => {
  const BRANCHES: Stmt[] = [
    { kind: "forward" },
    {
      kind: "if_sensor",
      sensor: "free",
      where: "front",
      then: [{ kind: "forward" }],
      else: [{ kind: "turn", dir: "left" }, { kind: "turn", dir: "right" }],
    },
  ];
  const at = (program: Stmt[], path: number[]) =>
    headless(program, blocksCanvasStrings, (ws) => {
      const block = blockAt(ws, path);
      return block === null ? null : `${block.type}${block.type === "turn" ? `:${block.getFieldValue("DIR")}` : ""}`;
    });

  it("follows the branch an if_sensor's path names: 0 then, 1 else", () => {
    expect(at(BRANCHES, [0])).toBe("forward");
    expect(at(BRANCHES, [1])).toBe("if_sensor");
    expect(at(BRANCHES, [1, 0, 0])).toBe("forward");
    expect(at(BRANCHES, [1, 1, 0])).toBe("turn:left");
    expect(at(BRANCHES, [1, 1, 1])).toBe("turn:right");
  });

  it("follows a loop's body, and finds nothing where the workspace holds nothing", () => {
    expect(at(EVERY_KIND, [2, 1])).toBe("turn:right");
    expect(at(EVERY_KIND, [3, 0, 0, 0])).toBe("turn:right");
    expect(at(BRANCHES, [1, 1, 5])).toBeNull();
    expect(at(BRANCHES, [7])).toBeNull();
  });

  it("names, for every event of a real run, a block of the event's own kind", () => {
    const run = runCase(SECRET_CONFIG.referenceSolution!, SECRET_CONFIG.cases[1]!);
    const kinds = headless(SECRET_CONFIG.referenceSolution!, blocksCanvasStrings, (ws) =>
      run.events.map((event) => [event.op, blockAt(ws, event.path)?.type] as const),
    );
    for (const [op, type] of kinds) {
      expect(op === "test" ? ["if_sensor", "repeat_until_dock"] : [op]).toContain(type);
    }
    expect(kinds.some(([op]) => op === "turn")).toBe(true);
  });
});

describe("the Code tab", () => {
  it("writes the JavaScript the blocks stand for, never to be run", () => {
    expect(roundTrip(EVERY_KIND, blocksCanvasStrings).code).toBe(
      [
        "robot.forward();",
        'robot.turn("left");',
        "for (let i = 0; i < 3; i++) {",
        "  robot.forward();",
        '  robot.turn("right");',
        "}",
        "while (!robot.atDock()) {",
        '  if (!robot.isFree("left")) {',
        '    robot.turn("right");',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("writes nothing for the empty program", () => {
    expect(roundTrip([], blocksCanvasStrings).code.trim()).toBe("");
  });

  it("writes the else branch when it holds a block", () => {
    expect(roundTrip(SECRET_CONFIG.referenceSolution!, blocksCanvasStrings).code).toContain(
      '  if (robot.isFree("front")) {\n    robot.forward();\n  } else {\n    robot.turn("right");\n  }',
    );
  });
});
