import { rng } from "@quiz/core/rng";
import { describe, expect, it } from "vitest";

import {
  checkCombinational,
  compileNetlist,
  evaluate,
  LOGIC_LIMITS,
  parseExpression,
  validateNetlist,
  type Bit,
  type Expr,
  type Netlist,
  type NetlistCell,
  type NetlistPort,
} from "../logic.js";

const GATE = { and: "$and", xor: "$xor", or: "$or" } as const;

/**
 * The test oracle's circuit: two-input gates computing each expression;
 * input port `A` drives net `in.A`, output port `Y` reads its expression's net.
 */
function netlistFromExpressions(exprs: Readonly<Record<string, Expr>>, inputs: readonly string[]): Netlist {
  const ports: Record<string, NetlistPort> = Object.fromEntries(inputs.map((name) => [name, { direction: "input", net: `in.${name}` }]));
  const cells: Record<string, NetlistCell> = {};
  const add = (type: NetlistCell["type"], connections: Record<string, string>): string => {
    const id = `c${Object.keys(cells).length}`;
    cells[id] = { type, connections: { ...connections, Y: `n.${id}` } };
    return `n.${id}`;
  };
  const compile = (e: Expr): string => {
    switch (e.kind) {
      case "var":
        return `in.${e.name}`;
      case "const":
        return add(e.value ? "$const1" : "$const0", {});
      case "not":
        return add("$not", { A: compile(e.arg) });
      default:
        return add(GATE[e.kind], { A0: compile(e.left), A1: compile(e.right) });
    }
  };
  for (const [name, e] of Object.entries(exprs)) ports[name] = { direction: "output", net: compile(e) };
  return { ports, cells };
}

const VARS = ["A", "B", "C", "D"];

function randomExpr(next: () => number, depth: number): Expr {
  const r = next();
  if (depth === 0 || r < 0.25) {
    return r < 0.05 ? { kind: "const", value: next() < 0.5 ? 0 : 1 } : { kind: "var", name: VARS[Math.floor(next() * VARS.length)]! };
  }
  if (r < 0.4) return { kind: "not", arg: randomExpr(next, depth - 1) };
  const kind = (["and", "or", "xor"] as const)[Math.floor(next() * 3)]!;
  return { kind, left: randomExpr(next, depth - 1), right: randomExpr(next, depth - 1) };
}

describe("checkCombinational", () => {
  it("simulates every random expression exactly as it evaluates, on every row", () => {
    const next = rng(459);
    for (let n = 0; n < 200; n++) {
      const exprs = { Y: randomExpr(next, 3), Z: randomExpr(next, 3) };
      const check = checkCombinational(netlistFromExpressions(exprs, VARS), exprs, VARS);
      expect(check.passed, JSON.stringify(exprs)).toBe(true);
      for (const row of check.rows) {
        const env = Object.fromEntries(VARS.map((name, j) => [name, row.inputs[j]!]));
        expect(row.actual).toEqual([evaluate(exprs.Y, env), evaluate(exprs.Z, env)]);
      }
    }
  });

  it("counts rows in binary, and marks every wrong output, X or Z included", () => {
    const and = { Y: parseExpression("A * B") };
    const or = netlistFromExpressions({ Y: parseExpression("A + B") }, ["A", "B"]);
    const check = checkCombinational(or, and, ["A", "B"]);
    expect(check.passed).toBe(false);
    expect(check.rows.map((r) => r.inputs)).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]]);
    expect(check.rows.map((r) => r.ok)).toEqual([[true], [false], [false], [true]]);
    expect(check.rows[1]).toEqual({ inputs: [0, 1], expected: [0], actual: [1], ok: [false] });

    const floating: Netlist = {
      ports: { A: { direction: "input", net: "a" }, Y: { direction: "output", net: "y" } },
      cells: { g: { type: "$and", connections: { A0: "a", Y: "y" } } },
    };
    expect(checkCombinational(floating, { Y: parseExpression("A") }, ["A"]).rows.map((r) => r.actual)).toEqual([[0], ["X"]]);
    expect(checkCombinational(floating, { W: parseExpression("A") }, ["A"]).rows.map((r) => r.actual)).toEqual([["Z"], ["Z"]]);
    // An output named like a prototype property is missing, not inherited.
    expect(checkCombinational(floating, { toString: parseExpression("A") }, ["A"]).rows.map((r) => r.actual)).toEqual([["Z"], ["Z"]]);
  });

  it("refuses more inputs than the limit", () => {
    const inputs = Array.from({ length: LOGIC_LIMITS.inputs + 1 }, (_, i) => `I${i}`);
    expect(() => checkCombinational({ ports: {}, cells: {} }, {}, inputs)).toThrow(/logic.too_many_inputs/);
  });

  it("grades a maximal netlist: 60 components, 10 inputs, 1024 rows", () => {
    const inputs = Array.from({ length: LOGIC_LIMITS.inputs }, (_, i) => `I${i}`);
    const exprs = Object.fromEntries(
      Object.entries({
        P: inputs.join(" ^ "),
        M: "(I0*I1 + I2*I3 + I4*I5 + I6*I7 + I8*I9)'",
        Q: "(I0+I1)*(I2+I3)*(I4+I5)*(I6+I7)*(I8+I9)",
        R: inputs.map((i) => `!${i}`).join(" * "),
        S: "(I0 ^ I9) + I1*I8 + !(I2 + I7)",
        T: "I3*I4*I5*I6 + 1*I0",
        U: "I9'",
      }).map(([name, source]) => [name, parseExpression(source, inputs)]),
    );
    const netlist = netlistFromExpressions(exprs, inputs);
    expect(Object.keys(netlist.cells)).toHaveLength(LOGIC_LIMITS.components);
    expect(validateNetlist(netlist)).toEqual([]);
    const check = checkCombinational(netlist, exprs, inputs);
    expect(check.rows).toHaveLength(1024);
    expect(check.passed).toBe(true);
  });

  /** Holding: I0..I9 and the 60 ring nets each change once. */
  const HOLD_EVENTS = 70;

  it("bounds the worst case: 1024 rows of 60 components that each exhaust the event budget", () => {
    // From a fresh simulator (every net X) under constant inputs, a loop
    // cannot start oscillating: the cells are monotone and X absorbs. A row
    // can only oscillate once an input changes, so each row here holds its
    // six rings low (I0 = 0), then releases them (I0 = 1).
    const inputs = Array.from({ length: LOGIC_LIMITS.inputs }, (_, i) => `I${i}`);
    const ports: Record<string, NetlistPort> = Object.fromEntries(inputs.map((name) => [name, { direction: "input", net: name }]));
    const cells: Record<string, NetlistCell> = {};
    for (let r = 0; r < 6; r++) {
      // A NAND, eight NOTs and a buffer: nine inversions, an odd ring.
      cells[`r${r}g0`] = { type: "$nand", connections: { A0: "I0", A1: `r${r}n9`, Y: `r${r}n0` } };
      for (let k = 1; k < 10; k++) {
        cells[`r${r}g${k}`] = { type: k === 9 ? "$buf" : "$not", connections: { A: `r${r}n${k - 1}`, Y: `r${r}n${k}` } };
      }
      ports[`Y${r}`] = { direction: "output", net: `r${r}n9` };
    }
    const compiled = compileNetlist({ ports, cells });
    expect(Object.keys(cells)).toHaveLength(LOGIC_LIMITS.components);
    const events = new Set<number>();
    const reads = new Set<string>();
    let oscillating = 0;
    const started = performance.now();
    for (let row = 0; row < 2 ** inputs.length; row++) {
      const sim = compiled.createSimulator();
      sim.set({ ...Object.fromEntries(inputs.map((name, j) => [name, ((row >> j) & 1) as Bit])), I0: 0 });
      events.add(sim.settle().events);
      sim.set({ I0: 1 });
      const run = sim.settle();
      if (run.oscillating.length === 60) oscillating++;
      events.add(run.events);
      reads.add(Object.values(sim.read()).join(""));
    }
    const elapsed = performance.now() - started;
    expect(oscillating).toBe(1024);
    expect(reads).toEqual(new Set(["XXXXXX"]));
    // Deterministic work: holding costs the same on every row, and releasing
    // spends the budget to the last step that fits: I0, then six ring nets
    // per step, 1 + 6 × 333 = 1999 ≤ 2000.
    expect([...events].sort((a, b) => a - b)).toEqual([HOLD_EVENTS, 1999]);
    // Wall clock only catches an algorithmic blow-up, never machine speed.
    expect(elapsed).toBeLessThan(5000);
  });
});
