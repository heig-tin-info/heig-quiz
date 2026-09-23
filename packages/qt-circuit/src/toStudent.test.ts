/**
 * The mandatory leak test (docs/spec/05 §5.7, invariant 4).
 *
 * Two independent checks, because either one alone is easy to satisfy by
 * accident: a forbidden-key list on the serialized student view, and a search
 * for the literal secret values of a fully populated configuration — a
 * reference whose designator and value are distinctive, a hidden stimulus, a
 * rubric and a tolerance.
 */
import { describe, expect, it } from "vitest";

import { COMMON_FORBIDDEN_STUDENT_KEYS } from "@quiz/core/server";

import { CircuitStudent } from "./schema.js";
import { circuitServer } from "./server.js";
import {
  SECRET_HIDDEN_STIMULUS,
  SECRET_REFERENCE_NAME,
  SECRET_REFERENCE_VALUE,
  SECRET_RUBRIC,
  SECRET_TOLERANCE,
  circuitConfig,
} from "./test/fixtures.js";

/*
 * The shared floor (`@quiz/core/server`) plus what only `circuit` has: the
 * reference schematic, the grading block it lives beside, and the `mode` of
 * that block — which tells the student whether a simulation or an LLM reads
 * the answer.
 */
const FORBIDDEN_KEYS = [
  ...COMMON_FORBIDDEN_STUDENT_KEYS,
  // Out of the floor since R-06 (only `code` publishes it, on purpose); here it
  // still names nothing this type may publish.
  "compare",
  "expected",
  "grading",
  "mode",
  "policy",
  "reference",
  "tolerance",
];

const SECRET_VALUES = [
  SECRET_REFERENCE_NAME,
  SECRET_REFERENCE_VALUE,
  SECRET_HIDDEN_STIMULUS,
  SECRET_RUBRIC,
  String(SECRET_TOLERANCE),
  "Csecret",
  // The hidden stimulus is a 5 V step at 1 ms: its shape is part of the key.
  "\"step\"",
];

const view = { seed: 7, itemId: "item-1", shuffle: true };

describe("circuitServer.toStudent", () => {
  const config = circuitConfig();
  const student = circuitServer.toStudent(config, view);
  const serialized = JSON.stringify(student);

  it("produces a value its own schema accepts", () => {
    expect(CircuitStudent.safeParse(student).success).toBe(true);
  });

  it("leaks no forbidden key", () => {
    for (const key of FORBIDDEN_KEYS) {
      expect(serialized, key).not.toContain(`"${key}"`);
    }
  });

  it("leaks no secret value", () => {
    for (const secret of SECRET_VALUES) {
      expect(serialized, secret).not.toContain(secret);
    }
  });

  it("publishes the visible stimuli, and counts the hidden ones", () => {
    expect(student.visibleStimuli.map((s) => s.name)).toEqual(["1 kHz sine", "10 kHz sine"]);
    expect(student.visibleStimuli[0]).toEqual({
      name: "1 kHz sine",
      source: { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 0 },
      sourceOhms: 0,
      load: { kind: "open" },
      analysis: { stopMs: 5, skipMs: 0, points: 500 },
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

  it("is stable: the same config gives the same view whatever the seed", () => {
    expect(JSON.stringify(circuitServer.toStudent(config, { ...view, seed: 99 }))).toBe(serialized);
  });
});

describe("circuitServer.toSolution", () => {
  it("carries the key, which is why the feedback policy gates it", () => {
    const solution = circuitServer.toSolution(circuitConfig(), view);
    expect(JSON.stringify(solution)).toContain(SECRET_REFERENCE_NAME);
    expect(solution.grading.rubric).toBe(SECRET_RUBRIC);
    expect(solution.grading.tolerance).toBe(SECRET_TOLERANCE);
    expect(solution.stimuli.map((s) => s.name)).toContain(SECRET_HIDDEN_STIMULUS);
  });
});
