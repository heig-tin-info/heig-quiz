/**
 * The `logic` type's server half (docs/spec/04 §4.18, ADR-123): the config's
 * refine through the domain's parser, the answer's limits, the netlist
 * rebuilt from the schematic, the grade over the whole truth table, the two
 * machine reasons, and the student exit of the config and of the details.
 */
import { describe, expect, it } from "vitest";

import { findStudentLeaks } from "@quiz/core/testing";
import { LOGIC_LIMITS } from "@quiz/domain/logic";

import { gradeLogic } from "./logicGrade.js";
import { gateCount, LOGIC_PARTS, offeredLogicKinds } from "./logicLibrary.js";
import { buildLogicNetlist } from "./logicNetlist.js";
import { LogicAnswer, LogicConfig, referenceUndefinedRow, type LogicSchematic } from "./logicSchema.js";
import { fitTerminals, vectorsFromReference } from "./logicReference.js";
import { logicServer } from "./logicServer.js";
import {
  halfAdderSchematic,
  logicConfig,
  logicLeakFixture,
  logicPart,
  logicReferenceConfig,
  logicReferenceLeakFixture,
  logicSequentialConfig,
  logicSequentialLeakFixture,
  logicWire,
  SECRET_MAJORITY,
  SECRET_PARITY,
  SECRET_REFERENCE_GATES,
  SECRET_VECTORS,
} from "./testing.js";

const ctx = { itemPoints: 4, seed: 0, itemId: "item-1" } as Parameters<typeof gradeLogic>[2];
const view = { seed: 3, itemId: "item-1", shuffle: true };

const part = logicPart;
const halfAdder = (): LogicSchematic => halfAdderSchematic();

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

  const nots = (n: number) => Array.from({ length: n }, (_, i) => part(`c${i + 10}`, "NOT", 100 + (i % 10) * 60, 40 + Math.floor(i / 10) * 60));

  it("holds the gates to the budget the canvas counts, whatever the constants", () => {
    const constants = [part("c90", "LOW", 40, 480), part("c91", "LOW", 80, 480), part("c92", "HIGH", 120, 480)];
    expect(LogicAnswer.safeParse({ schematic: { components: [...nots(LOGIC_LIMITS.gates), ...constants], wires: [] } }).success).toBe(true);
    expect(LogicAnswer.safeParse({ schematic: { components: nots(LOGIC_LIMITS.gates + 1), wires: [] } }).success).toBe(false);
  });

  it("refuses two parts with one id: a wire names its pin by it", () => {
    const schematic = halfAdder();
    schematic.components.push({ ...schematic.components[2]!, x: 400, y: 400 });
    const parsed = LogicAnswer.safeParse({ schematic });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("logic.duplicate_id");
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

  it("drives every LOW part from one cell, never counted as a gate", () => {
    const schematic = halfAdder();
    schematic.components.push(part("c7", "LOW", 400, 420), part("c8", "LOW", 400, 460));
    const { netlist } = buildLogicNetlist(schematic);
    expect(Object.values(netlist.cells).filter((c) => c.type === "$const0")).toHaveLength(1);
    expect(gateCount(schematic)).toBe(2);
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

describe("a sequential question (test vectors)", () => {
  /** A D flip-flop from the palette, its Q on the output: right on every step of `SECRET_VECTORS`. */
  function flipFlop(output: 2 | 3 = 2): LogicSchematic {
    const clk = part("c1", "IN", 100, 300, "clk");
    const d = part("c2", "IN", 100, 100, "d");
    const ff = part("c3", "DFF", 300, 200, "U1");
    const q = part("c4", "OUT", 500, 180, "q");
    return {
      components: [clk, d, ff, q],
      wires: [logicWire("w1", [d, 0], [ff, 0]), logicWire("w2", [clk, 0], [ff, 1]), logicWire("w3", [ff, output], [q, 0])],
    };
  }

  it("keeps a combinational question written before it valid, unchanged", () => {
    const stored = { configVersion: 1, prompt: "p", inputs: ["a", "b"], outputs: [{ name: "y", expression: "a*b" }] };
    const parsed = LogicConfig.parse(stored);
    expect(parsed).toMatchObject({ ...stored, mode: "combinational", vectors: "" });
  });

  it("reads the vectors instead of the expressions, refusing them with their line", () => {
    expect(logicSequentialConfig().outputs).toEqual([{ name: "q", expression: "" }]);
    const parsed = LogicConfig.safeParse({ ...logicSequentialConfig(), vectors: "clk d q\n0 0 0\nC 2 1" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]).toMatchObject({ message: "logic.vector_value", path: ["vectors"], params: { line: 3 } });
  });

  it("gives every point to a flip-flop right on every checked step", () => {
    const result = grade(logicSequentialConfig(), flipFlop());
    expect(result).toMatchObject({ kind: "graded", points: 4, state: "validated" });
    if (result.kind !== "graded") return;
    expect(result.details).toMatchObject({ inputs: ["clk", "d"], right: 4, total: 4, rows: [] });
  });

  it("counts the steps whose checked outputs are all right, and no step that checks nothing", () => {
    // Q̄ wired to q: wrong where Q and Q̄ differ, i.e. on every step.
    const vectors = `${SECRET_VECTORS}C 1 X\n`;
    const result = grade(logicSequentialConfig({ vectors }), flipFlop(3));
    expect(result).toMatchObject({ points: 0 });
    if (result.kind !== "graded") return;
    expect(result.details).toMatchObject({ right: 0, total: 4, outputs: [{ name: "q", rate: 0 }] });
    expect(result.details.rows?.[1]).toEqual({ inputs: ["C", 1], actual: [0], expected: [1] });
  });

  it("serves no vector to a student, and keys the vectors only", () => {
    const student = logicServer.toStudent(logicSequentialLeakFixture.config, view);
    expect(findStudentLeaks(student, logicSequentialLeakFixture)).toEqual([]);
    expect(student).toEqual({
      prompt: "Build a D flip-flop's behaviour.",
      symbols: "iec",
      inputs: ["clk", "d"],
      outputs: ["q"],
      palette: { kinds: ["DFF"], maxGates: 2 },
    });
    expect(logicServer.toSolution(logicSequentialConfig(), view)).toEqual({ outputs: [], vectors: SECRET_VECTORS });
  });

  it("fills the vectors' outputs from the reference, on the teacher's stimulus (Use as reference)", () => {
    // A stimulus alone is a draft, not yet a valid config: the button fills it.
    const config = { ...logicSequentialConfig({ reference: flipFlop() }), vectors: "clk d q\n0 1\nC 1\nC 0  # falls\n" };
    const filled = vectorsFromReference(config);
    expect(filled).toEqual({ vectors: "clk d q\n0   1 0\nC   1 1\nC   0 0 # falls\n" });
    if (!("vectors" in filled)) return;
    expect(grade(logicSequentialConfig({ vectors: filled.vectors }), flipFlop())).toMatchObject({ points: 4 });
    expect(vectorsFromReference(logicSequentialConfig())).toEqual({ problem: "logic.reference_missing" });
    const renamed = { ...flipFlop(), components: flipFlop().components.map((c) => (c.name === "q" ? { ...c, name: "r" } : c)) };
    expect(vectorsFromReference(logicSequentialConfig({ reference: renamed }))).toEqual({ problem: "logic.reference_ports" });
  });

  it("gives a flip-flop a Q and a Q̄ beside its inputs", () => {
    expect(LOGIC_PARTS.part("DFF").pins.map((p) => p.name)).toEqual(["D", "CLK", "Q", "QN"]);
    expect(LOGIC_PARTS.part("JKFF").pins.map((p) => p.name)).toEqual(["J", "CLK", "K", "Q", "QN"]);
    expect(buildLogicNetlist(flipFlop()).netlist.cells["c3"]).toMatchObject({ type: "$dff" });
  });
});

describe("a reference circuit as the key", () => {
  const issueOf = (config: unknown) => {
    const parsed = LogicConfig.safeParse(config);
    return parsed.success ? null : parsed.error.issues[0];
  };

  it("needs a reference whose terminals are the declared ones, never the expressions", () => {
    expect(logicReferenceConfig().outputs).toEqual([
      { name: "c", expression: "" },
      { name: "s", expression: "" },
    ]);
    expect(issueOf({ ...logicReferenceConfig(), reference: null })).toMatchObject({
      message: "logic.reference_missing",
      path: ["reference"],
    });
    expect(issueOf({ ...logicReferenceConfig(), inputs: ["a", "x"] })?.message).toBe("logic.reference_ports");
  });

  it("refuses a latch or a flip-flop in a combinational reference", () => {
    const reference = halfAdderSchematic();
    reference.components.push(part("c9", "DFF", 300, 460, "U9"));
    expect(issueOf({ ...logicReferenceConfig({ palette: { kinds: ["AND", "XOR", "DFF"], maxGates: 4 } }), reference })?.message).toBe(
      "logic.reference_memory",
    );
  });

  it("refuses at publication, never on a read, a reference that reads X or Z on a row", () => {
    // The AND's second input left open: c reads X when a = 1 (rows 2 and 3).
    const open = halfAdderSchematic();
    open.wires = open.wires.filter((w) => w.id !== "w3");
    // Every read parses the config: it never simulates the reference.
    const config = LogicConfig.parse({ ...logicReferenceConfig(), reference: open });
    expect(logicServer.publicationIssues!(config)).toEqual([{ path: ["reference"], message: "logic.reference_undefined" }]);
    expect(referenceUndefinedRow({ ...config, reference: open })).toBe(2);
    expect(logicServer.publicationIssues!(logicReferenceConfig())).toEqual([]);
    // A draft tried in that state is not compared with anything.
    expect(grade(config, halfAdder())).toMatchObject({ points: 0, state: "proposed", details: { reason: "reference_undefined" } });
  });

  it("grades against the reference exactly as against the same expressions", () => {
    const orCarry: LogicSchematic = {
      ...halfAdderSchematic(),
      components: halfAdderSchematic().components.map((c) => (c.kind === "AND2" ? { ...c, kind: "OR2" } : c)),
    };
    const palette = { kinds: ["AND", "OR", "XOR"], maxGates: 4 };
    const byReference = grade(logicReferenceConfig({ palette }), orCarry);
    expect(byReference).toEqual(grade(LogicConfig.parse({ ...halfAdderConfig(), palette }), orCarry));
    expect(byReference).toMatchObject({ points: 2 });
    expect(grade(logicReferenceConfig(), halfAdder())).toMatchObject({ points: 4, state: "validated" });
  });

  it("never serves the reference, and keys it", () => {
    for (const fixture of [logicLeakFixture, logicReferenceLeakFixture]) {
      const student = logicServer.toStudent(fixture.config, view);
      expect(findStudentLeaks(student, fixture)).toEqual([]);
      for (const gate of SECRET_REFERENCE_GATES) expect(JSON.stringify(student)).not.toContain(gate);
    }
    // The key IS the circuit: read-only where the key may be shown, never in the student view.
    expect(logicServer.toSolution(logicReferenceConfig(), view)).toEqual({
      outputs: [],
      reference: halfAdderSchematic(SECRET_REFERENCE_GATES as [string, string]),
    });
  });
});

describe("the reference's terminals follow the declared names (fitTerminals)", () => {
  const declared = { inputs: ["a", "b"], outputs: ["c", "s"] };

  it("renames in place, the wires kept", () => {
    const fitted = fitTerminals(halfAdder(), declared, { inputs: ["a", "x"], outputs: ["c", "s"] });
    expect(fitted.components.find((c) => c.id === "c2")?.name).toBe("x");
    expect(fitted.wires).toEqual(halfAdder().wires);
  });

  it("drops a terminal no longer declared with its wires, and places a new one", () => {
    const fewer = fitTerminals(halfAdder(), declared, { inputs: ["a"], outputs: ["c", "s"] });
    expect(fewer.components.map((c) => c.id)).not.toContain("c2");
    expect(fewer.wires.map((w) => w.id)).toEqual(["w1", "w2", "w5", "w6"]);
    const more = fitTerminals(halfAdder(), declared, { inputs: ["a", "b"], outputs: ["c", "s", "t"] });
    expect(more.components.at(-1)).toMatchObject({ id: "c7", kind: "OUT", name: "t" });
    expect(LogicAnswer.safeParse({ schematic: more }).success).toBe(true);
  });
});
