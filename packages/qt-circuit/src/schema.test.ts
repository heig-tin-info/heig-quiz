import { describe, expect, it } from "vitest";

import {
  CircuitAnswer,
  CircuitConfig,
  DEFAULT_ANALYSIS,
  acPointCount,
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
      stimuli: [emptyStimulus({ name: "s", analysis: { kind: "tran", stopMs: 1, skipMs: 2, points: 500 } })],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("circuit.skip_after_stop");
  });
});

describe("the analysis of a stimulus", () => {
  const base = { ...emptyCircuitConfig(), prompt: "Draw it." };
  const withStimulus = (stimulus: Record<string, unknown>) =>
    CircuitConfig.safeParse({
      ...base,
      stimuli: [{ name: "s", source: { kind: "dc", volts: 0 }, load: { kind: "open" }, ...stimulus }],
    });
  const messages = (parsed: ReturnType<typeof withStimulus>) => JSON.stringify(parsed.error?.issues ?? []);

  it("reads a config written before the AC sweep as a transient", () => {
    const parsed = withStimulus({ analysis: { kind: "tran", stopMs: 2, skipMs: 1, points: 100 } });
    expect(parsed.data?.stimuli[0]?.analysis).toEqual({ kind: "tran", stopMs: 2, skipMs: 1, points: 100 });
    expect(withStimulus({}).data?.stimuli[0]?.analysis).toEqual(DEFAULT_ANALYSIS);
  });

  it("accepts an AC sweep on a DC bias, with 20 points per decade by default", () => {
    const parsed = withStimulus({ analysis: { kind: "ac", fStartHz: 10, fStopHz: 1e5 } });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.stimuli[0]?.analysis).toEqual({
      kind: "ac",
      fStartHz: 10,
      fStopHz: 1e5,
      pointsPerDecade: 20,
    });
  });

  it("refuses an AC sweep on anything but a DC source", () => {
    const parsed = withStimulus({
      source: { kind: "sine", amplitude: 1, frequencyHz: 1000 },
      analysis: { kind: "ac", fStartHz: 10, fStopHz: 1e5 },
    });
    expect(parsed.success).toBe(false);
    expect(messages(parsed)).toContain("circuit.ac_needs_dc_source");
  });

  it("refuses a band that starts after it stops, or leaves the schema's bounds", () => {
    expect(messages(withStimulus({ analysis: { kind: "ac", fStartHz: 1e4, fStopHz: 1e4 } }))).toContain(
      "circuit.ac_start_after_stop",
    );
    expect(withStimulus({ analysis: { kind: "ac", fStartHz: 0.001, fStopHz: 10 } }).success).toBe(false);
    expect(withStimulus({ analysis: { kind: "ac", fStartHz: 1, fStopHz: 2e9 } }).success).toBe(false);
    expect(
      withStimulus({ analysis: { kind: "ac", fStartHz: 1, fStopHz: 10, pointsPerDecade: 4 } }).success,
    ).toBe(false);
  });

  it("caps a sweep at the 2000 points of ADR-019", () => {
    // 11 decades × 200 points is 2201 frequencies.
    const tooMany = withStimulus({ analysis: { kind: "ac", fStartHz: 0.01, fStopHz: 1e9, pointsPerDecade: 200 } });
    expect(messages(tooMany)).toContain("circuit.ac_too_many_points");
    // 9 decades × 200 + 1 = 1801.
    expect(
      withStimulus({ analysis: { kind: "ac", fStartHz: 1, fStopHz: 1e9, pointsPerDecade: 200 } }).success,
    ).toBe(true);
  });

  it("counts the frequencies `.ac dec` produces, both ends included", () => {
    expect(acPointCount({ kind: "ac", fStartHz: 100, fStopHz: 1e4, pointsPerDecade: 5 })).toBe(11);
    expect(acPointCount({ kind: "ac", fStartHz: 10, fStopHz: 1e5, pointsPerDecade: 20 })).toBe(81);
  });

  it("fills the Bode envelope with its defaults under an older grading block", () => {
    const parsed = CircuitConfig.parse({ ...base, grading: { mode: "manual", tolerance: 0.05, rubric: "" } });
    expect(parsed.grading.bode).toEqual({ magDb: 1, floorDb: 60, phaseDeg: 10 });
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
