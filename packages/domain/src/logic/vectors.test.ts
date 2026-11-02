import { describe, expect, it } from "vitest";

import {
  checkSequential,
  LOGIC_LIMITS,
  LogicError,
  parseVectors,
  type Netlist,
  type NetlistCell,
  type NetlistPort,
} from "../logic.js";

const declared = { inputs: ["clk", "d"], outputs: ["q"] };

/** The error code and line `parseVectors` throws, or `null`. */
function errorOf(source: string, signals = declared): [string, number | null] | null {
  try {
    parseVectors(source, signals);
    return null;
  } catch (error) {
    if (!(error instanceof LogicError)) throw error;
    return [error.code, error.position];
  }
}

describe("parseVectors", () => {
  it("reads the header, the steps, the comments and the blank lines", () => {
    const vectors = parseVectors("# a D flip-flop\nq clk d\n\n0 0 0\nX C 1  # don't care\n1 c 1\n0 C 0\n", declared);
    expect(vectors).toEqual({
      inputs: ["clk", "d"],
      outputs: ["q"],
      rows: [
        { inputs: [0, 0], outputs: [0] },
        { inputs: ["C", 1], outputs: ["X"] },
        { inputs: ["C", 1], outputs: [1] },
        { inputs: ["C", 0], outputs: [0] },
      ],
    });
  });

  it.each([
    ["nothing", "", ["logic.vector_empty", null]],
    ["a header only", "clk d q", ["logic.vector_empty", null]],
    ["no checked output", "clk d q\nC 1 X", ["logic.vector_empty", null]],
    ["a signal missing", "clk q\n0 0", ["logic.vector_header", 1]],
    ["a signal twice", "clk d q q\n0 0 0 0", ["logic.vector_header", 1]],
    ["an undeclared signal", "\nclk d q e\n0 0 0 0", ["logic.vector_header", 2]],
    ["a short row", "clk d q\n0 0 0\n0 1", ["logic.vector_columns", 3]],
    ["a clock on an output", "clk d q\nC 0 C", ["logic.vector_value", 2]],
    ["a don't care on an input", "clk d q\nC X 0", ["logic.vector_value", 2]],
    ["another value", "clk d q\n0 0 Z", ["logic.vector_value", 2]],
  ])("refuses %s, with the line at fault", (_label, source, expected) => {
    expect(errorOf(source)).toEqual(expected);
  });

  it("holds the steps and the text to LOGIC_LIMITS", () => {
    const rows = (n: number) => `clk d q\n${"C 1 1\n".repeat(n)}`;
    expect(errorOf(rows(LOGIC_LIMITS.vectorRows))).toBeNull();
    expect(errorOf(rows(LOGIC_LIMITS.vectorRows + 1))).toEqual(["logic.vector_too_long", LOGIC_LIMITS.vectorRows + 2]);
    expect(errorOf(`clk d q\n0 0 0${" ".repeat(LOGIC_LIMITS.vectorLength)}`)).toEqual(["logic.vector_too_long", null]);
  });
});

const input = (net: string) => ({ direction: "input" as const, net });
const output = (net: string) => ({ direction: "output" as const, net });

/** A D flip-flop on `clk` and `d`, read on `q`. */
const dff: Netlist = {
  ports: { clk: input("clk"), d: input("d"), q: output("q") },
  cells: { f: { type: "$dff", connections: { CLK: "clk", D: "d", Q: "q" } } },
};

describe("checkSequential", () => {
  it("runs the steps in order on one simulator, from flip-flops at 0", () => {
    const check = checkSequential(dff, parseVectors("clk d q\n0 1 0\nC 1 1\n0 0 1\nC 0 0", declared));
    expect(check.passed).toBe(true);
    expect(check.rows.map((r) => r.actual)).toEqual([[0], [1], [1], [0]]);
  });

  it("checks no don't care, counts no step of don't cares, and reads a wrong or unknown output as wrong", () => {
    const signals = { inputs: ["clk", "d"], outputs: ["q", "r"] };
    const netlist: Netlist = { ...dff, ports: { ...dff.ports, r: output("q") } };
    const check = checkSequential(netlist, parseVectors("clk d q r\n0 1 1 X\nC 1 X X\nC 0 1 0", signals));
    expect(check.rows.map((r) => r.ok)).toEqual([
      [false, true],
      [false, true],
    ]);
    expect(check.passed).toBe(false);
    const open: Netlist = { ...dff, cells: {} };
    expect(checkSequential(open, parseVectors("clk d q\nC 1 1", declared)).rows[0]).toMatchObject({ actual: ["Z"], ok: [false] });
  });

  it("raises every clock of a step together", () => {
    // Two flip-flops on two clocks, the second fed by the first: pulsed together they shift.
    const netlist: Netlist = {
      ports: { a: input("a"), b: input("b"), d: input("d"), q0: output("q0"), q1: output("q1") },
      cells: {
        f0: { type: "$dff", connections: { CLK: "a", D: "d", Q: "q0" } },
        f1: { type: "$dff", connections: { CLK: "b", D: "q0", Q: "q1" } },
      },
    };
    const signals = { inputs: ["a", "b", "d"], outputs: ["q0", "q1"] };
    const check = checkSequential(netlist, parseVectors("a b d q0 q1\nC C 1 1 0\nC C 0 0 1", signals));
    expect(check.passed).toBe(true);
  });

  it("bounds the worst case: every step releases 60 cells of rings until the budget runs out", () => {
    const cells: Record<string, NetlistCell> = {};
    const ports: Record<string, NetlistPort> = { e: input("e") };
    for (let r = 0; r < 6; r++) {
      cells[`r${r}g0`] = { type: "$nand", connections: { A0: "e", A1: `r${r}n9`, Y: `r${r}n0` } };
      // A NAND, eight NOTs and a buffer: nine inversions, an odd ring (as `check.test.ts`).
      for (let k = 1; k < 10; k++) {
        cells[`r${r}g${k}`] = { type: k === 9 ? "$buf" : "$not", connections: { A: `r${r}n${k - 1}`, Y: `r${r}n${k}` } };
      }
      ports[`y${r}`] = output(`r${r}n9`);
    }
    const outputs = Object.keys(ports).slice(1);
    const header = `e ${outputs.join(" ")}`;
    // The rings are held by e = 0, released while the clock is high (the
    // budget runs out), held again when it falls: every ring net then reads 1.
    const step = `C ${outputs.map(() => "1").join(" ")}`;
    const source = `${header}\n${`${step}\n`.repeat(LOGIC_LIMITS.vectorRows)}`;
    const started = performance.now();
    const check = checkSequential({ ports, cells }, parseVectors(source, { inputs: ["e"], outputs }));
    expect(check.rows).toHaveLength(LOGIC_LIMITS.vectorRows);
    expect(check.passed).toBe(true);
    // Only catches an algorithmic blow-up, never machine speed.
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
