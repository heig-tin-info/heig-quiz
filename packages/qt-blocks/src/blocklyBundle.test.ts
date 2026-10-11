/**
 * Our syntax tree through a Blockly workspace and back (ADR-103 §5), and the
 * JavaScript of the Code tab — headless, under Node, with the bundle's own
 * block definitions.
 */
import { describe, expect, it } from "vitest";

import type { Stmt } from "@quiz/domain/blocks";

import { roundTrip, workspaceState } from "./blocklyBundle.js";
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
    const french = { ...blocksCanvasStrings, blocklyLocale: "fr", ifSensor: "si {where} est {sensor}" };
    expect(roundTrip(EVERY_KIND, french).program).toEqual(EVERY_KIND);
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
