import { describe, expect, it } from "vitest";

import { fromCanonical, toCanonical } from "./canonical.js";
import { CircuitConfig, emptyCircuitConfig } from "./schema.js";
import { circuitConfig, rcLowPass } from "./test/fixtures.js";

describe("toCanonical", () => {
  it("writes down only what the schema cannot rebuild", () => {
    const minimal = CircuitConfig.parse({ ...emptyCircuitConfig(), prompt: "Draw a divider." });
    // Nothing but the prompt: every other field is at its default.
    expect(toCanonical(minimal)).toEqual({ prompt: "Draw a divider." });
  });

  it("keeps the storage's own business out of the file", () => {
    const canonical = toCanonical(circuitConfig());
    expect(canonical["configVersion"]).toBeUndefined();
  });

  it("leaves a stimulus's defaults out", () => {
    const config = CircuitConfig.parse({
      ...emptyCircuitConfig(),
      prompt: "Filter it.",
      stimuli: [
        {
          name: "1 kHz",
          source: { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 0 },
          load: { kind: "open" },
        },
      ],
    });
    expect(toCanonical(config)["stimuli"]).toEqual([
      {
        name: "1 kHz",
        source: { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 0 },
        load: { kind: "open" },
      },
    ]);
  });

  it("writes the reference verbatim: a schematic is geometry", () => {
    const canonical = toCanonical(circuitConfig()) as { reference: { components: unknown[] } };
    expect(canonical.reference.components).toHaveLength(3);
    expect(JSON.stringify(canonical.reference)).toContain("Rsecret");
  });
});

describe("the round trip", () => {
  it("is exact for a fully populated config", () => {
    const config = circuitConfig();
    expect(fromCanonical(toCanonical(config))).toStrictEqual(config);
  });

  it("is exact for a bare one", () => {
    const config = CircuitConfig.parse({ ...emptyCircuitConfig(), prompt: "Draw it." });
    expect(fromCanonical(toCanonical(config))).toStrictEqual(config);
  });

  it("is exact for a manual question with a reference and no stimulus", () => {
    const config = CircuitConfig.parse({
      ...emptyCircuitConfig(),
      prompt: "Draw the same filter.",
      commonGround: false,
      supplies: { vcc: 12, vee: -12 },
      palette: { kinds: ["R", "C", "OPAMP", "GND", "VCC", "VEE"], maxComponents: 8 },
      reference: rcLowPass().schematic,
      grading: { mode: "manual", tolerance: 0.05, rubric: "Check the corner frequency." },
      simulationsPerMinute: 3,
    });
    const canonical = toCanonical(config);
    expect(canonical["commonGround"]).toBe(false);
    expect(canonical["simulationsPerMinute"]).toBe(3);
    expect(fromCanonical(canonical)).toStrictEqual(config);
  });

  it("refuses a canonical file the schema rejects", () => {
    expect(() => fromCanonical({ prompt: "" })).toThrow();
    expect(() => fromCanonical({ prompt: "x", grading: { mode: "simulation" } })).toThrow();
    expect(() => fromCanonical(null)).toThrow();
  });
});
