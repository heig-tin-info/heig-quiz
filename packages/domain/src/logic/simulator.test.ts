import { describe, expect, it } from "vitest";

import {
  CELL_SPECS,
  cellInputs,
  compileNetlist,
  LOGIC_LIMITS,
  validateNetlist,
  type Bit,
  type CellType,
  type Netlist,
  type NetlistCell,
  type NetlistPort,
  type Simulator,
  type Value,
} from "../logic.js";

const input = (net: string): NetlistPort => ({ direction: "input", net });
const output = (net: string): NetlistPort => ({ direction: "output", net });
const cell = (type: CellType, connections: Record<string, string>, width?: number): NetlistCell =>
  width === undefined ? { type, connections } : { type, connections, params: { width } };
const simulate = (netlist: Netlist): Simulator => compileNetlist(netlist).createSimulator();

/** A one-cell circuit: each cell port is wired to a circuit port of the same name. */
function single(type: CellType, width?: number): Netlist {
  const u = cell(type, {}, width);
  const ins = cellInputs(u);
  const outs = CELL_SPECS[type].outputs;
  return {
    ports: Object.fromEntries([...ins.map((p) => [p, input(p)]), ...outs.map((p) => [p, output(p)])]),
    cells: { u: { ...u, connections: Object.fromEntries([...ins, ...outs].map((p) => [p, p])) } },
  };
}

function settled(netlist: Netlist, inputs: Record<string, Value>): Record<string, Value> {
  const sim = simulate(netlist);
  sim.set(inputs);
  expect(sim.settle().oscillating).toEqual([]);
  return sim.read();
}

describe("validateNetlist", () => {
  it("accepts a well-formed netlist and names each structural fault", () => {
    expect(validateNetlist(single("$tribuf"))).toEqual([]);
    const bad = {
      ports: { P: { direction: "inout", net: "p" } },
      cells: {
        a: { type: "$mux", connections: {} },
        t: { type: "toString", connections: {} },
        b: cell("$not", { A: "x", B: "y" }),
        c: cell("$and", { A0: "x", A2: "y" }),
        d: cell("$not", { A: "x" }, 2),
        e: cell("$or", {}, 5),
        f: cell("$xor", {}, 2.5),
      },
    };
    expect(validateNetlist(bad)).toEqual([
      { code: "bad_direction", port: "P" },
      { code: "unknown_cell_type", cell: "a" },
      { code: "unknown_cell_type", cell: "t" },
      { code: "unknown_port", cell: "b", port: "B" },
      { code: "unknown_port", cell: "c", port: "A2" },
      { code: "bad_width", cell: "d" },
      { code: "bad_width", cell: "e" },
      { code: "bad_width", cell: "f" },
    ]);
    expect(() => compileNetlist(bad as unknown as Netlist)).toThrow(/logic.netlist_invalid/);
  });

  it("reports a malformed shape instead of throwing", () => {
    for (const shape of [null, 3, [], {}, { ports: {} }, { ports: [], cells: {} }]) {
      expect(validateNetlist(shape)).toEqual([{ code: "malformed" }]);
    }
    expect(
      validateNetlist({
        ports: { a: null, b: { direction: "input" }, c: { direction: "input", net: 3 } },
        cells: {
          n: null,
          m: { type: "$not" },
          k: { type: "$not", connections: { A: 1 } },
          p: { type: "$and", connections: {}, params: 2 },
        },
      }),
    ).toEqual([
      { code: "malformed", port: "a" },
      { code: "malformed", port: "b" },
      { code: "malformed", port: "c" },
      { code: "malformed", cell: "n" },
      { code: "malformed", cell: "m" },
      { code: "malformed", cell: "k" },
      { code: "malformed", cell: "p" },
    ]);
  });

  it("caps the components, the inputs and the outputs", () => {
    const many = <T,>(n: number, prefix: string, make: (i: number) => T): Record<string, T> =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, make(i)]));
    const at: Netlist = {
      ports: { ...many(LOGIC_LIMITS.inputs, "i", (i) => input(`i${i}`)), ...many(LOGIC_LIMITS.outputs, "o", (i) => output(`o${i}`)) },
      cells: many(LOGIC_LIMITS.components, "c", () => cell("$const0", {})),
    };
    expect(validateNetlist(at)).toEqual([]);
    const over: Netlist = {
      ports: { ...many(LOGIC_LIMITS.inputs + 1, "i", (i) => input(`i${i}`)), ...many(LOGIC_LIMITS.outputs + 1, "o", (i) => output(`o${i}`)) },
      cells: many(LOGIC_LIMITS.components + 1, "c", () => cell("$const0", {})),
    };
    expect(validateNetlist(over)).toEqual([{ code: "too_many_components" }, { code: "too_many_inputs" }, { code: "too_many_outputs" }]);
  });

  it("takes prototype names as ordinary port, cell and net names", () => {
    const netlist = JSON.parse(`{
      "ports": { "__proto__": { "direction": "input", "net": "constructor" }, "toString": { "direction": "output", "net": "__proto__" } },
      "cells": { "__proto__": { "type": "$not", "connections": { "A": "constructor", "Y": "__proto__" } } }
    }`) as Netlist;
    expect(validateNetlist(netlist)).toEqual([]);
    const sim = simulate(netlist);
    sim.set({ ["__proto__"]: 1 });
    sim.settle();
    expect(Object.entries(sim.read())).toEqual([["toString", 0]]);
    expect(Object.entries(sim.nets())).toEqual([
      ["constructor", 1],
      ["__proto__", 0],
    ]);
  });
});

describe("cells", () => {
  const fns: Partial<Record<CellType, (b: Bit[]) => boolean>> = {
    $and: (b) => b.every((x) => x === 1),
    $or: (b) => b.some((x) => x === 1),
    $nand: (b) => !b.every((x) => x === 1),
    $nor: (b) => !b.some((x) => x === 1),
    $xor: (b) => b.filter((x) => x === 1).length % 2 === 1,
    $xnor: (b) => b.filter((x) => x === 1).length % 2 === 0,
  };

  it("computes every gate at every fan-in", () => {
    for (const [type, fn] of Object.entries(fns) as [CellType, (b: Bit[]) => boolean][]) {
      for (const width of [2, 3, 4]) {
        for (let row = 0; row < 2 ** width; row++) {
          const bits = Array.from({ length: width }, (_, i) => ((row >> i) & 1) as Bit);
          const inputs = Object.fromEntries(bits.map((b, i) => [`A${i}`, b]));
          expect(settled(single(type, width), inputs).Y, `${type} ${bits.join("")}`).toBe(fn(bits) ? 1 : 0);
        }
      }
    }
    expect(settled(single("$and"), { A0: 1, A1: 1 }).Y).toBe(1);
    expect(settled(single("$not"), { A: 0 }).Y).toBe(1);
    expect(settled(single("$buf"), { A: 1 }).Y).toBe(1);
    expect(settled(single("$const0"), {}).Y).toBe(0);
    expect(settled(single("$const1"), {}).Y).toBe(1);
  });

  it("reads a floating or unknown input as X, unless the other inputs decide", () => {
    expect(settled(single("$and"), { A0: 1 }).Y).toBe("X");
    expect(settled(single("$and"), { A0: 0 }).Y).toBe(0);
    expect(settled(single("$or"), { A0: 1, A1: "Z" }).Y).toBe(1);
    expect(settled(single("$xor"), { A0: "X", A1: 0 }).Y).toBe("X");
    const unwired = { ports: { Y: output("y") }, cells: { u: cell("$nand", { A0: "nowhere", Y: "y" }) } };
    expect(settled(unwired, {}).Y).toBe("X");
  });

  it("resolves several drivers on a net: Z yields, equal values agree, a conflict is X", () => {
    const shared: Netlist = {
      ports: { A: input("a"), B: input("b"), EA: input("ea"), EB: input("eb"), Y: output("bus") },
      cells: {
        ta: cell("$tribuf", { A: "a", EN: "ea", Y: "bus" }),
        tb: cell("$tribuf", { A: "b", EN: "eb", Y: "bus" }),
      },
    };
    expect(settled(shared, { A: 1, B: 0, EA: 1, EB: 0 }).Y).toBe(1);
    expect(settled(shared, { A: 1, B: 0, EA: 0, EB: 1 }).Y).toBe(0);
    expect(settled(shared, { A: 1, B: 0, EA: 0, EB: 0 }).Y).toBe("Z");
    expect(settled(shared, { A: 1, B: 1, EA: 1, EB: 1 }).Y).toBe(1);
    expect(settled(shared, { A: 1, B: 0, EA: 1, EB: 1 }).Y).toBe("X");
    expect(settled(shared, { A: 1, B: 0, EA: "X", EB: 0 }).Y).toBe("X");
    const wired: Netlist = {
      ports: { A: input("a"), B: input("b"), Y: output("y") },
      cells: { ba: cell("$buf", { A: "a", Y: "y" }), bb: cell("$buf", { A: "b", Y: "y" }) },
    };
    expect(settled(wired, { A: 0, B: 0 }).Y).toBe(0);
    expect(settled(wired, { A: 0, B: 1 }).Y).toBe("X");
  });
});

describe("feedback and the event budget", () => {
  /** Q = NOR(R, QN), QN = NOR(S, Q). */
  const norLatch: Netlist = {
    ports: { S: input("s"), R: input("r"), Q: output("q"), QN: output("qn") },
    cells: {
      g1: cell("$nor", { A0: "r", A1: "qn", Y: "q" }),
      g2: cell("$nor", { A0: "s", A1: "q", Y: "qn" }),
    },
  };

  it("sets, holds and resets a NOR-built RS latch", () => {
    const sim = simulate(norLatch);
    const apply = (inputs: Record<string, Value>): Record<string, Value> => {
      sim.set(inputs);
      expect(sim.settle().oscillating).toEqual([]);
      return sim.read();
    };
    expect(apply({ S: 0, R: 0 })).toEqual({ Q: "X", QN: "X" });
    expect(apply({ S: 1 })).toEqual({ Q: 1, QN: 0 });
    expect(apply({ S: 0 })).toEqual({ Q: 1, QN: 0 });
    expect(apply({ R: 1 })).toEqual({ Q: 0, QN: 1 });
    expect(apply({ R: 0 })).toEqual({ Q: 0, QN: 1 });
  });

  it("sets the race of releasing S = R = 1 together to X, within the budget", () => {
    const sim = simulate(norLatch);
    sim.set({ S: 1, R: 1 });
    sim.settle();
    expect(sim.read()).toEqual({ Q: 0, QN: 0 });
    sim.set({ S: 0, R: 0 });
    expect(sim.settle()).toEqual({ oscillating: ["q", "qn"], events: LOGIC_LIMITS.eventsPerRow });
    expect(sim.read()).toEqual({ Q: "X", QN: "X" });
    sim.set({ S: 1 });
    expect(sim.settle().oscillating).toEqual([]);
    expect(sim.read()).toEqual({ Q: 1, QN: 0 });
  });

  it("leaves a lone inverter loop at X, where it starts", () => {
    const ring = { ports: { Y: output("y") }, cells: { n: cell("$not", { A: "y", Y: "y" }) } };
    expect(settled(ring, {}).Y).toBe("X");
  });

  it("on exhaustion, sets every toggling net to X, keeps a decided one, and starts the next settle afresh", () => {
    // A NAND ring; one AND reads it beside a 0 (decided), another beside a 1 (toggling).
    const netlist: Netlist = {
      ports: { EN: input("en"), K: input("k"), Y: output("y"), D: output("d"), T: output("t") },
      cells: {
        n: cell("$nand", { A0: "en", A1: "y", Y: "y" }),
        d: cell("$and", { A0: "y", A1: "zero", Y: "d" }),
        z: cell("$const0", { Y: "zero" }),
        t: cell("$and", { A0: "y", A1: "k", Y: "t" }),
      },
    };
    const sim = simulate(netlist);
    sim.set({ EN: 0, K: 1 });
    expect(sim.settle().oscillating).toEqual([]);
    expect(sim.read()).toEqual({ Y: 1, D: 0, T: 1 });
    sim.set({ EN: 1 });
    const result = sim.settle();
    expect(result.oscillating).toEqual(["y", "t"]);
    expect(result.events).toBeLessThanOrEqual(LOGIC_LIMITS.eventsPerRow);
    expect(sim.read()).toEqual({ Y: "X", D: 0, T: "X" });
    // Nothing changed: the fresh evaluation finds the same X fixed point.
    expect(sim.settle()).toEqual({ oscillating: [], events: 0 });
    sim.set({ EN: 0 });
    expect(sim.settle().oscillating).toEqual([]);
    expect(sim.read()).toEqual({ Y: 1, D: 0, T: 1 });
  });
});

describe("the simulator API", () => {
  it("counts one event per net change, the delay included", () => {
    const chain: Netlist = {
      ports: { A: input("a"), Y: output("c") },
      cells: { b1: cell("$not", { A: "a", Y: "b" }), b2: cell("$not", { A: "b", Y: "c" }) },
    };
    const sim = simulate(chain);
    expect(sim.nets()).toEqual({ a: "X", b: "X", c: "X" });
    sim.set({ A: 1 });
    expect(sim.settle()).toEqual({ oscillating: [], events: 3 });
    expect(sim.nets()).toEqual({ a: 1, b: 0, c: 1 });
  });

  it("swallows a change undone before it takes effect", () => {
    const sim = simulate(single("$not"));
    sim.set({ A: 1 });
    sim.set({ A: "X" });
    expect(sim.settle()).toEqual({ oscillating: [], events: 0 });
  });

  it("refuses an unknown input and a value outside 0, 1, X, Z", () => {
    const sim = simulate(single("$not"));
    expect(() => sim.set({ B: 1 })).toThrow(/logic.unknown_input/);
    expect(() => sim.set({ A: 2 as unknown as Value })).toThrow(/logic.bad_value/);
    expect(() => sim.set({ A: "x" as Value })).toThrow(/logic.bad_value/);
  });

  it("is deterministic", () => {
    const run = (): Record<string, Value> => {
      const sim = simulate(single("$xnor", 4));
      sim.set({ A0: 1, A1: 0, A2: 1, A3: 1 });
      sim.settle();
      return sim.nets();
    };
    expect(run()).toEqual(run());
  });
});
