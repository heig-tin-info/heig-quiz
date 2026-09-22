import { describe, expect, it } from "vitest";

import {
  CircuitAnswer,
  CircuitConfig,
  Wire,
  emptyCircuitConfig,
  emptyStimulus,
  totalStimulusPoints,
} from "./schema.js";
import { circuitConfig, rcLowPass } from "./test/fixtures.js";

describe("emptyCircuitConfig", () => {
  it("is a blank draft: the shape, the defaults, no content (decision D16)", () => {
    const draft = emptyCircuitConfig();
    expect(draft.configVersion).toBe(1);
    expect(draft.prompt).toBe("");
    expect(draft.stimuli).toEqual([]);
    expect(draft.reference).toBeNull();
    // Blank, so it does NOT validate: publication is the gate.
    expect(CircuitConfig.safeParse(draft).success).toBe(false);
  });

  it("parses once it has a prompt", () => {
    expect(CircuitConfig.safeParse({ ...emptyCircuitConfig(), prompt: "Draw a divider." }).success).toBe(
      true,
    );
  });
});

describe("the three refinements", () => {
  const base = { ...emptyCircuitConfig(), prompt: "Draw it." };

  it("refuses `simulation` without a reference", () => {
    const parsed = CircuitConfig.safeParse({
      ...base,
      stimuli: [emptyStimulus({ name: "s" })],
      grading: { mode: "simulation", tolerance: 0.05, rubric: "" },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("circuit.simulation_needs_reference");
  });

  it("refuses `simulation` without a stimulus", () => {
    const parsed = CircuitConfig.safeParse({
      ...base,
      reference: rcLowPass().schematic,
      grading: { mode: "simulation", tolerance: 0.05, rubric: "" },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("circuit.simulation_needs_stimulus");
  });

  it("refuses `showExpected` without a reference", () => {
    const parsed = CircuitConfig.safeParse({ ...base, showExpected: true });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("circuit.expected_needs_reference");
  });

  it("refuses a stimulus whose window is skipped whole", () => {
    const parsed = CircuitConfig.safeParse({
      ...base,
      stimuli: [emptyStimulus({ name: "s", analysis: { stopMs: 1, skipMs: 2, points: 500 } })],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("circuit.skip_after_stop");
  });
});

describe("the schematic", () => {
  it("refuses a wire vertex off the grid", () => {
    const off = Wire.safeParse({
      id: "w1",
      a: { kind: "free", x: 0, y: 0 },
      b: { kind: "free", x: 30, y: 0 },
      points: [
        [0, 0],
        [30, 0],
      ],
    });
    expect(off.success).toBe(false);
  });

  it("accepts a vertex on the grid", () => {
    const on = Wire.safeParse({
      id: "w1",
      a: { kind: "free", x: 0, y: 0 },
      b: { kind: "free", x: 40, y: 0 },
      points: [
        [0, 0],
        [40, 0],
      ],
    });
    expect(on.success).toBe(true);
  });

  it("accepts the RC fixture as an answer", () => {
    expect(CircuitAnswer.safeParse({ schematic: rcLowPass().schematic }).success).toBe(true);
  });

  it("refuses an orientation that is not a rotation or a reflection", () => {
    const parsed = CircuitAnswer.safeParse({
      schematic: {
        components: [{ id: "c1", kind: "R", x: 0, y: 0, m: [1, 1, 1, 1], name: "R1", value: "1k" }],
        wires: [],
      },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("totalStimulusPoints", () => {
  it("adds the weights of every stimulus, hidden ones included", () => {
    expect(totalStimulusPoints(circuitConfig())).toBe(4);
    expect(totalStimulusPoints(emptyCircuitConfig())).toBe(0);
  });
});
