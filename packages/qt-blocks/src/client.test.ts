import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Stmt } from "@quiz/domain/blocks";

import { blocksClient } from "./client.js";
import { pseudoCode } from "./pseudo.js";
import { blocksCanvasStrings } from "./strings.js";
import { SECRET_CONFIG } from "./testing.js";
import { applyTool, resizeRows } from "./MapEditor.js";
import { nextStop, replayState } from "./Simulation.js";
import { runCase } from "./grade.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(join(HERE, file), "utf8");

describe("blocksClient", () => {
  it("starts from the empty program, which is not an answer", () => {
    const empty = blocksClient.emptyAnswer({} as never);
    expect(empty).toEqual({ program: [] });
    expect(blocksClient.isAnswered(empty)).toBe(false);
    expect(blocksClient.isAnswered({ program: [{ kind: "forward" }] })).toBe(true);
    expect(blocksClient.wide).toBeUndefined();
  });

  /*
   * ADR-103 §11: Blockly lives in `blocklyBundle.ts`, reached by ONE dynamic
   * import. A static import of it, or of Blockly, from anything the client
   * entry or the server entry reaches would put Blockly in the app's first
   * chunk or in the API.
   */
  it("keeps Blockly in the bundle, reached by one dynamic import", () => {
    for (const file of ["client.tsx", "server.ts", "schema.ts", "grade.ts", "grading.tsx", "pseudo.ts", "strings.ts", "Player.tsx", "Editor.tsx", "Review.tsx", "Key.tsx", "Simulation.tsx", "CaseTable.tsx", "MapEditor.tsx", "WarehouseMap.tsx"]) {
      expect(source(file), file).not.toMatch(/from "blockly|import\("blockly|blocklyBundle\.js"/);
    }
    const host = source("BlocklyHost.tsx");
    expect(host).toMatch(/await import\("\.\/blocklyBundle\.js"\)/);
    expect(host).not.toMatch(/^import [^t].*blocklyBundle/m);
  });
});

describe("pseudoCode", () => {
  it("writes a program in the canvas's words, two spaces a level", () => {
    expect(pseudoCode(SECRET_CONFIG.referenceSolution!, blocksCanvasStrings)).toBe(
      ["repeat until the dock", "  if free ahead", "    move forward", "  else", "    turn right"].join("\n"),
    );
    expect(pseudoCode([{ kind: "repeat", times: 3, body: [{ kind: "turn", dir: "left" }] }], blocksCanvasStrings)).toBe(
      "repeat 3 times\n  turn left",
    );
    expect(pseudoCode([], blocksCanvasStrings)).toBe("");
  });

  it("leaves out an empty else", () => {
    const program: Stmt[] = [{ kind: "if_sensor", sensor: "blocked", where: "right", then: [{ kind: "forward" }], else: [] }];
    expect(pseudoCode(program, blocksCanvasStrings)).toBe("if blocked on the right\n  move forward");
  });
});

describe("the map editor's rules", () => {
  const rows = [">..", ".#.", "..D"];

  it("cycles floor and rack, and leaves the start and the dock alone", () => {
    expect(applyTool(rows, "rack", 1, 0)).toEqual([">#.", ".#.", "..D"]);
    expect(applyTool(rows, "rack", 1, 1)).toEqual([">..", "...", "..D"]);
    expect(applyTool(rows, "rack", 0, 0)).toEqual(rows);
    expect(applyTool(rows, "rack", 2, 2)).toEqual(rows);
  });

  it("moves the start keeping its heading, and turns it on a second click", () => {
    expect(applyTool(rows, "start", 2, 0)).toEqual(["..>", ".#.", "..D"]);
    expect(applyTool(rows, "start", 0, 0)).toEqual(["v..", ".#.", "..D"]);
    expect(applyTool(["<..", "...", "..D"], "start", 0, 0)).toEqual(["^..", "...", "..D"]);
    expect(applyTool(rows, "start", 2, 2)).toEqual(rows);
    expect(applyTool(["...", "...", "..D"], "start", 1, 1)).toEqual(["...", ".>.", "..D"]);
  });

  it("moves the dock, never onto the start", () => {
    expect(applyTool(rows, "dock", 2, 0)).toEqual([">.D", ".#.", "..."]);
    expect(applyTool(rows, "dock", 0, 0)).toEqual(rows);
  });

  it("resizes with floor, cropping what falls outside", () => {
    expect(resizeRows(rows, 4, 4)).toEqual([">...", ".#..", "..D.", "...."]);
    expect(resizeRows(rows, 3, 3)).toEqual(rows);
    expect(resizeRows([">...", "...D"], 3, 3)).toEqual([">..", "...", "..."]);
  });
});

describe("the simulation's replay", () => {
  const kase = SECRET_CONFIG.cases[1]!;
  const run = runCase(SECRET_CONFIG.referenceSolution!, kase);
  const start = { x: 0, y: 1, heading: 1 as const };

  it("starts at the start, with nothing walked", () => {
    expect(replayState(run, start, 0)).toMatchObject({ pose: start, trail: [{ x: 0, y: 1 }], moves: 0, path: null, done: false });
  });

  it("stops after each move or turn, a sensor's test shown with what follows it", () => {
    expect(run.events[0]!.op).toBe("test");
    const first = nextStop(run, 0);
    expect(run.events[first - 1]!.op).not.toBe("test");
    expect(replayState(run, start, first).moves).toBeLessThanOrEqual(1);
  });

  it("ends where the run ended, with its moves", () => {
    const end = replayState(run, start, run.events.length);
    expect(end.done).toBe(true);
    expect(end.moves).toBe(run.moves);
    expect(end.trail).toEqual(run.trail);
    expect(nextStop(run, run.events.length)).toBe(run.events.length);
  });
});
