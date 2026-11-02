/**
 * The `logic` type's server half (docs/spec/04 §4.18, ADR-123): the config's
 * refine through the domain's parser, the answer's limits, the netlist
 * rebuilt from the schematic, the grade over the whole truth table, the two
 * machine reasons, and the student exit of the config and of the details.
 */
import { describe, expect, it } from "vitest";

import { findStudentLeaks } from "@quiz/core/testing";

import { gradeLogic } from "./logicGrade.js";
import { LOGIC_PARTS, offeredLogicKinds } from "./logicLibrary.js";
import { buildLogicNetlist } from "./logicNetlist.js";
import { LogicAnswer, LogicConfig, type LogicComponent, type LogicSchematic } from "./logicSchema.js";
import { logicServer } from "./logicServer.js";
import { logicConfig, logicLeakFixture, logicWire, SECRET_MAJORITY, SECRET_PARITY } from "./testing.js";

const ctx = { itemPoints: 4, seed: 0, itemId: "item-1" } as Parameters<typeof gradeLogic>[2];
const view = { seed: 3, itemId: "item-1", shuffle: true };

const part = (id: string, kind: LogicComponent["kind"], x: number, y: number, name: string = kind): LogicComponent => ({
  id,
  kind,
  x,
  y,
  m: [1, 0, 0, 1],
  name,
  value: "",
});

/** A half adder: `c = a*b` from an AND, `s = a^b` from an XOR. */
function halfAdder(): LogicSchematic {
  const a = part("c1", "IN", 100, 100, "a");
  const b = part("c2", "IN", 100, 300, "b");
  const and = part("c3", "AND2", 300, 140, "U1");
  const xor = part("c4", "XOR2", 300, 300, "U2");
  const c = part("c5", "OUT", 500, 140, "c");
  const s = part("c6", "OUT", 500, 300, "s");
  return {
    components: [a, b, and, xor, c, s],
    wires: [
      logicWire("w1", [a, 0], [and, 0]),
      logicWire("w2", [a, 0], [xor, 0]),
      logicWire("w3", [b, 0], [and, 1]),
      logicWire("w4", [b, 0], [xor, 1]),
      logicWire("w5", [and, 2], [c, 0]),
      logicWire("w6", [xor, 2], [s, 0]),
    ],
  };
}

const halfAdderConfig = (outputs = [{ name: "c", expression: "a*b" }, { name: "s", expression: "a ^ b" }]) =>
  LogicConfig.parse({
    configVersion: 1,
    prompt: "Build a half adder.",
    inputs: ["a", "b"],
    outputs,
    palette: { kinds: ["AND", "XOR"], maxGates: 4 },
  });

const grade = (config: LogicConfig, schematic: LogicSchematic | null) =>
  gradeLogic(config, schematic === null ? null : LogicAnswer.parse({ schematic }), ctx);

describe("the logic config", () => {
  const issue = (config: unknown) => {
    const parsed = LogicConfig.safeParse(config);
    return parsed.success ? null : parsed.error.issues[0];
  };

  it("accepts the leak fixture and defaults to IEC symbols", () => {
    expect(logicConfig().symbols).toBe("iec");
  });

  it("refuses an expression it cannot read, with its position", () => {
    const found = issue({ ...logicConfig(), outputs: [{ name: "m", expression: "a * (b + c" }] });
    expect(found?.message).toBe("logic.expression_invalid");
    expect(found?.path).toEqual(["outputs", 0, "expression"]);
  });

  it("refuses a name that is no declared input, juxtaposition included", () => {
    const found = issue({ ...logicConfig(), outputs: [{ name: "m", expression: "ab + c" }] });
    expect(found?.message).toBe("logic.unknown_identifier");
    expect((found as { params?: { position?: number } }).params?.position).toBe(0);
  });

  it("refuses a name used twice across the inputs and the outputs", () => {
    expect(issue({ ...logicConfig(), outputs: [{ name: "a", expression: "b*c" }] })?.message).toBe("logic.duplicate_name");
  });

  it("holds the declared ports to LOGIC_LIMITS", () => {
    const inputs = Array.from({ length: 11 }, (_, i) => `i${i}`);
    expect(issue({ ...logicConfig(), inputs, outputs: [{ name: "m", expression: "i0*i1" }] })?.path).toEqual(["inputs"]);
  });
});

describe("the logic answer", () => {
  it("refuses a kind the library does not declare", () => {
    const schematic = halfAdder();
    schematic.components[2] = { ...schematic.components[2]!, kind: "MUX" as never };
    expect(LogicAnswer.safeParse({ schematic }).success).toBe(false);
  });

  it("refuses more cells than the netlist allows", () => {
    const gates = Array.from({ length: 61 }, (_, i) => part(`c${i + 10}`, "NOT", 100 + (i % 10) * 60, 40 + Math.floor(i / 10) * 60));
    expect(LogicAnswer.safeParse({ schematic: { components: gates, wires: [] } }).success).toBe(false);
  });

  it("offers every fan-in of the allowed families, and the constants", () => {
    expect(offeredLogicKinds(["NAND", "NOT"])).toEqual(["NAND2", "NAND3", "NAND4", "NOT", "LOW", "HIGH"]);
  });
});

describe("the netlist rebuilt from the schematic", () => {
  it("names the declared terminals as ports and every gate as a cell", () => {
    const { netlist, netOfWire } = buildLogicNetlist(halfAdder());
    expect(Object.keys(netlist.ports).sort()).toEqual(["a", "b", "c", "s"]);
    expect(netlist.cells["c3"]).toMatchObject({ type: "$and", params: { width: 2 } });
    // Two wires leaving the same pin carry the same net.
    expect(netOfWire.get("w1")).toBe(netOfWire.get("w2"));
    expect(netOfWire.get("w1")).not.toBe(netOfWire.get("w3"));
  });
});

describe("logicServer.grade", () => {
  it("gives every point to a circuit right on every row", () => {
    const result = grade(halfAdderConfig(), halfAdder());
    expect(result).toMatchObject({ kind: "graded", points: 4, maxPoints: 4, state: "validated" });
    if (result.kind !== "graded") return;
    expect(result.details).toMatchObject({ right: 4, total: 4, rows: [] });
    expect(result.details.outputs).toEqual([
      { name: "c", rate: 1 },
      { name: "s", rate: 1 },
    ]);
  });

  it("gives the share of rows whose outputs are ALL right", () => {
    // The carry is graded as an OR: rows 01 and 10 fail, the sum stays right.
    const result = grade(halfAdderConfig([{ name: "c", expression: "a + b" }, { name: "s", expression: "a^b" }]), halfAdder());
    expect(result).toMatchObject({ points: 2 });
    if (result.kind !== "graded") return;
    expect(result.details.right).toBe(2);
    expect(result.details.outputs).toEqual([
      { name: "c", rate: 0.5 },
      { name: "s", rate: 1 },
    ]);
    expect(result.details.rows).toEqual([
      { inputs: [0, 1], actual: [0, 1], expected: [1, 1] },
      { inputs: [1, 0], actual: [0, 1], expected: [1, 1] },
    ]);
  });

  it("reads an output nothing drives as wrong", () => {
    const schematic = halfAdder();
    schematic.wires = schematic.wires.filter((w) => w.id !== "w6");
    const result = grade(halfAdderConfig(), schematic);
    expect(result).toMatchObject({ points: 0 });
    if (result.kind !== "graded") return;
    expect(result.details.rows?.[0]?.actual).toEqual([0, "Z"]);
  });

  it("grades an answer with only the question's terminals as empty", () => {
    const schematic = halfAdder();
    const result = grade(halfAdderConfig(), {
      components: schematic.components.filter((c) => c.kind === "IN" || c.kind === "OUT"),
      wires: [],
    });
    expect(result).toMatchObject({ points: 0, state: "validated", details: { reason: "empty" } });
    expect(grade(halfAdderConfig(), null)).toMatchObject({ points: 0, details: { reason: "empty" } });
  });

  it.each([
    ["a declared input missing", (s: LogicSchematic) => ({ ...s, components: s.components.filter((c) => c.name !== "b") })],
    ["a declared input twice", (s: LogicSchematic) => ({ ...s, components: [...s.components, part("c9", "IN", 100, 400, "a")] })],
    ["an undeclared output", (s: LogicSchematic) => ({ ...s, components: s.components.map((c) => (c.name === "s" ? { ...c, name: "q" } : c)) })],
    [
      "a wire to a pin that does not exist",
      (s: LogicSchematic) => ({ ...s, wires: s.wires.map((w) => (w.id === "w1" ? { ...w, b: { kind: "pin" as const, c: "c3", p: 5 } } : w)) }),
    ],
  ])("never simulates %s: 0, proposed, ports_mismatch", (_label, change) => {
    const result = grade(halfAdderConfig(), change(halfAdder()));
    expect(result).toMatchObject({ points: 0, state: "proposed", comment: "ports_mismatch", details: { reason: "ports_mismatch" } });
  });

  it.each([
    ["a gate outside the palette", { kinds: ["XOR"], maxGates: null }],
    ["more gates than maxGates", { kinds: ["AND", "XOR"], maxGates: 1 }],
  ])("never simulates %s: 0, proposed, palette_violation", (_label, palette) => {
    const result = grade(LogicConfig.parse({ ...halfAdderConfig(), palette }), halfAdder());
    expect(result).toMatchObject({ points: 0, state: "proposed", comment: "palette_violation" });
  });
});

describe("what reaches a student (invariant 4)", () => {
  it("serves the full config without an expression, by key and by value", () => {
    const student = logicServer.toStudent(logicLeakFixture.config, view);
    expect(findStudentLeaks(student, logicLeakFixture)).toEqual([]);
    expect(JSON.stringify(student)).not.toContain(SECRET_MAJORITY);
    expect(JSON.stringify(student)).not.toContain(SECRET_PARITY);
    expect(student).toEqual({
      prompt: "Build the majority and the parity of three inputs.",
      symbols: "iec",
      inputs: ["a", "b", "c"],
      outputs: ["m", "p"],
      palette: { kinds: ["AND", "OR", "XOR"], maxGates: 8 },
    });
    expect(logicServer.studentSchema.safeParse(student).success).toBe(true);
  });

  it("keeps the failing rows home unless the key may be shown", () => {
    const graded = grade(halfAdderConfig([{ name: "c", expression: "a + b" }, { name: "s", expression: "a^b" }]), halfAdder());
    if (graded.kind !== "graded") throw new Error("not graded");
    const hidden = logicServer.studentDetails!(graded.details, { showKey: false, showHiddenCaseNames: false });
    const keys = JSON.stringify(hidden).match(/"[A-Za-z]+":/g) ?? [];
    expect(keys).not.toContain('"rows":');
    expect(keys).not.toContain('"expected":');
    expect(hidden).toMatchObject({ right: 2, total: 4, outputs: [{ name: "c", rate: 0.5 }, { name: "s", rate: 1 }] });
    const shown = logicServer.studentDetails!(graded.details, { showKey: true, showHiddenCaseNames: false });
    expect(shown).toHaveProperty("rows");
  });

  it("keys the expressions, and only them", () => {
    expect(logicServer.toSolution(logicConfig(), view)).toEqual({
      outputs: [
        { name: "m", expression: SECRET_MAJORITY },
        { name: "p", expression: SECRET_PARITY },
      ],
    });
  });

  it("has a pin for every name of its cells", () => {
    expect(LOGIC_PARTS.part("NOT").pins.map((p) => p.name)).toEqual(["A", "Y"]);
    expect(LOGIC_PARTS.part("OR4").pins.map((p) => p.name)).toEqual(["A0", "A1", "A2", "A3", "Y"]);
  });
});
