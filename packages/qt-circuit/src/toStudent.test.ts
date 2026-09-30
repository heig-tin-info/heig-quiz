/**
 * The type-specific half of the leak test (docs/spec/05 §5.7, invariant 4).
 * The generic half — the full fixture of `./testing.ts` (a reference whose
 * designator and value are distinctive, a hidden stimulus, a rubric and a
 * tolerance) searched for every forbidden key and secret value, and parsed by
 * the student schema — is the registry's contract test.
 */
import { describe, expect, it } from "vitest";

import { findStudentLeaks } from "@quiz/core/testing";

import { circuitServer } from "./server.js";
import {
  SECRET_HIDDEN_STIMULUS,
  SECRET_REFERENCE_NAME,
  SECRET_RUBRIC,
  SECRET_TOLERANCE,
  circuitConfig,
  circuitLeakFixture,
} from "./test/fixtures.js";

const view = { seed: 7, itemId: "item-1", shuffle: true };

describe("circuitServer.toStudent", () => {
  const config = circuitConfig();
  const student = circuitServer.toStudent(config, view);
  const serialized = JSON.stringify(student);

  it("publishes the visible stimuli, and counts the hidden ones", () => {
    expect(student.visibleStimuli.map((s) => s.name)).toEqual(["1 kHz sine", "10 kHz sine"]);
    expect(student.visibleStimuli[0]).toEqual({
      name: "1 kHz sine",
      source: { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 0 },
      sourceOhms: 0,
      load: { kind: "open" },
      analysis: { kind: "tran", stopMs: 5, skipMs: 0, points: 500 },
      points: 1,
    });
    expect(student.hiddenCount).toBe(1);
    expect(student.hiddenPoints).toBe(2);
  });

  it("says what the canvas may offer, which is not the key", () => {
    expect(student.prompt).toBe(config.prompt);
    expect(student.palette).toEqual({ kinds: ["R", "C", "L", "GND"], maxComponents: 6 });
    expect(student.supplies).toEqual({ vcc: null, vee: null });
    expect(student.commonGround).toBe(true);
    expect(student.simulationsPerMinute).toBe(10);
  });

  it("turns the Simulate button off when no stimulus is visible", () => {
    expect(student.canSimulate).toBe(true);
    const hiddenOnly = circuitConfig({
      stimuli: [
        {
          name: SECRET_HIDDEN_STIMULUS,
          source: { kind: "dc", volts: 1 },
          load: { kind: "open" },
          visible: false,
        },
      ],
    });
    const none = circuitServer.toStudent(hiddenOnly, view);
    expect(none.canSimulate).toBe(false);
    expect(none.visibleStimuli).toEqual([]);
    expect(none.hiddenCount).toBe(1);
  });

  it("publishes an AC sweep's band, never the envelope that grades it", () => {
    const ac = circuitConfig({
      stimuli: [
        {
          name: "Bode",
          source: { kind: "dc", volts: 0 },
          load: { kind: "open" },
          analysis: { kind: "ac", fStartHz: 10, fStopHz: 1e5, pointsPerDecade: 20 },
        },
      ],
    });
    const sweep = circuitServer.toStudent(ac, view);
    expect(sweep.visibleStimuli[0]?.analysis).toEqual({
      kind: "ac",
      fStartHz: 10,
      fStopHz: 1e5,
      pointsPerDecade: 20,
    });
    expect(findStudentLeaks(sweep, circuitLeakFixture)).toEqual([]);
  });

  it("is stable: the same config gives the same view whatever the seed", () => {
    expect(JSON.stringify(circuitServer.toStudent(config, { ...view, seed: 99 }))).toBe(serialized);
  });
});

describe("circuitServer.toSolution", () => {
  it("carries the reference, which is why the feedback policy gates it", () => {
    const solution = circuitServer.toSolution(circuitConfig(), view);
    expect(JSON.stringify(solution)).toContain(SECRET_REFERENCE_NAME);
  });

  it("does not carry the stimuli nor the grading block (ADR-037)", () => {
    const solution = circuitServer.toSolution(circuitConfig(), view);
    expect(Object.keys(solution)).toEqual(["reference"]);
    const serialized = JSON.stringify(solution);
    expect(serialized).not.toContain(SECRET_RUBRIC);
    expect(serialized).not.toContain(SECRET_HIDDEN_STIMULUS);
    expect(serialized).not.toContain(String(SECRET_TOLERANCE));
  });
});
