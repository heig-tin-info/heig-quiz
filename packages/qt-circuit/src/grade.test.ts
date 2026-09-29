import { describe, expect, it } from "vitest";

import type { FinalizeContext, GradeContext, RunnerService } from "@quiz/core/server";
import { isGraded, isPendingLlm, isPendingRunner } from "@quiz/core/server";

import {
  buildRunnerRequest,
  caseLayout,
  compareBode,
  compareSeries,
  finalizeRunnerCircuit,
  gradeCircuit,
  interactiveRequest,
  isEmptyAnswer,
  parseSimulation,
  studentDetails,
  wrapDegrees,
} from "./grade.js";
import { circuitServer } from "./server.js";
import { EMPTY_SCHEMATIC, type CircuitAnswer, type CircuitConfig } from "./schema.js";
import {
  SECRET_HIDDEN_STIMULUS,
  SECRET_RUBRIC,
  circuitConfig,
  component,
  failedCase,
  lowPassBode,
  okCase,
  outcome,
  rcAnswer,
  resetIds,
  sineSeries,
  storedBeforeAc,
} from "./test/fixtures.js";

const runner: RunnerService = {
  run: () => Promise.reject(new Error("no runner in a unit test")),
  health: () => Promise.resolve({ ok: false, languages: [], queued: 0, avgMs: null }),
};

const ctx: GradeContext = {
  seed: 7,
  itemId: "item-1",
  attemptId: "attempt-1",
  itemPoints: 8,
  now: new Date("2026-09-22T10:00:00Z"),
  runner,
};

const finalizeCtx: FinalizeContext = {
  seed: ctx.seed,
  itemId: ctx.itemId,
  attemptId: ctx.attemptId,
  itemPoints: ctx.itemPoints,
  now: ctx.now,
};

const manual = (overrides: Record<string, unknown> = {}): CircuitConfig =>
  circuitConfig({ grading: { mode: "manual", tolerance: 0.05, rubric: "" }, ...overrides });

describe("isEmptyAnswer", () => {
  it("is true for nothing at all, and only that", () => {
    expect(isEmptyAnswer(null)).toBe(true);
    expect(isEmptyAnswer({ schematic: EMPTY_SCHEMATIC })).toBe(true);
    expect(isEmptyAnswer(rcAnswer())).toBe(false);
    resetIds();
    expect(
      isEmptyAnswer({ schematic: { components: [component("GND", "GND", 100, 100)], wires: [] } }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The request layout
// ---------------------------------------------------------------------------

describe("caseLayout", () => {
  const config = circuitConfig();

  it("puts the student decks first, then the reference ones", () => {
    const layout = caseLayout(config, {
      priority: "grading",
      stimulusIndexes: [0, 1, 2],
      withReference: true,
    });
    expect(layout.map((l) => l.name)).toEqual(["s0", "s1", "s2", "r0", "r1", "r2"]);
    expect(layout.map((l) => l.role)).toEqual([
      "student",
      "student",
      "student",
      "reference",
      "reference",
      "reference",
    ]);
    expect(layout.map((l) => l.stimulusIndex)).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it("drops the reference half when it is not asked for, or there is none", () => {
    expect(
      caseLayout(config, { priority: "grading", stimulusIndexes: [0, 1], withReference: false }).map(
        (l) => l.name,
      ),
    ).toEqual(["s0", "s1"]);
    expect(
      caseLayout(manual({ reference: null, showExpected: false }), {
        priority: "grading",
        stimulusIndexes: [0],
        withReference: true,
      }).map((l) => l.name),
    ).toEqual(["s0"]);
  });
});

describe("buildRunnerRequest", () => {
  it("sends one deck per case, named in `args` for `ngspice -b`", () => {
    const { request, layout } = buildRunnerRequest(circuitConfig(), rcAnswer(), {
      priority: "grading",
      stimulusIndexes: [0, 1, 2],
      withReference: true,
    });
    expect(request.language).toBe("spice");
    expect(request.action).toBe("run");
    expect(request.compileArgs).toBe("");
    expect(request.limits).toEqual({ timeMs: 10_000, memoryMb: 256, outputKb: 256 });
    expect(request.files.map((f) => f.name)).toEqual([
      "s0.cir",
      "s1.cir",
      "s2.cir",
      "r0.cir",
      "r1.cir",
      "r2.cir",
    ]);
    expect(request.cases.map((c) => c.args)).toEqual([
      ["s0.cir"],
      ["s1.cir"],
      ["s2.cir"],
      ["r0.cir"],
      ["r1.cir"],
      ["r2.cir"],
    ]);
    expect(layout).toHaveLength(6);
    // Four stimuli × two decks is exactly `RunnerRequest.files`'s cap of 8.
    expect(request.files.length).toBeLessThanOrEqual(8);
  });

  it("builds the decks server-side from the STORED schematics (invariant 14)", () => {
    const { request } = buildRunnerRequest(circuitConfig(), rcAnswer(), {
      priority: "grading",
      stimulusIndexes: [0],
      withReference: true,
    });
    expect(request.files[0]?.content).toContain("R1 in out 1.59e+3");
    // The reference deck carries the teacher's own components, not the student's.
    expect(request.files[1]?.content).toContain("Rsecret in out 1.234e+5");
  });
});

describe("interactiveRequest", () => {
  it("runs the visible stimuli and nothing else", () => {
    const request = interactiveRequest(circuitConfig(), rcAnswer());
    expect(request?.priority).toBe("interactive");
    expect(request?.files.map((f) => f.name)).toEqual(["s0.cir", "s1.cir"]);
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("Rsecret");
    expect(serialized).not.toContain(SECRET_HIDDEN_STIMULUS);
    // The hidden stimulus is a 5 V step at 1 ms; its PWL table must not leak.
    expect(serialized).not.toContain("PWL");
  });

  it("adds the reference decks only when the teacher publishes the expected curve", () => {
    const shown = interactiveRequest(circuitConfig({ showExpected: true }), rcAnswer());
    expect(shown?.files.map((f) => f.name)).toEqual(["s0.cir", "s1.cir", "r0.cir", "r1.cir"]);
  });

  it("is null when there is nothing to run", () => {
    expect(interactiveRequest(circuitConfig(), { schematic: EMPTY_SCHEMATIC })).toBeNull();
    const hiddenOnly = circuitConfig({
      stimuli: [
        {
          name: "only hidden",
          source: { kind: "dc", volts: 1 },
          load: { kind: "open" },
          visible: false,
        },
      ],
    });
    expect(interactiveRequest(hiddenOnly, rcAnswer())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// compareSeries
// ---------------------------------------------------------------------------

describe("compareSeries", () => {
  it("is zero for two identical waveforms", () => {
    const s = sineSeries();
    expect(compareSeries(s, s)).toBe(0);
  });

  it("is small for a slightly shifted sine, and large for a wrong one", () => {
    const reference = sineSeries();
    const shifted = sineSeries({ phase: 0.05 });
    const small = compareSeries(shifted, reference) ?? 1;
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(0.05);
    const inverted = sineSeries({ amplitude: -1 });
    expect(compareSeries(inverted, reference) ?? 0).toBeGreaterThan(0.5);
  });

  it("resamples the student onto the reference's own grid", () => {
    const reference = sineSeries({ n: 64 });
    const finer = sineSeries({ n: 257 });
    expect(compareSeries(finer, reference) ?? 1).toBeLessThan(0.01);
  });

  it("measures in volts when the reference does not move", () => {
    const flat = { t: [0, 1, 2], vin: [0, 0, 0], vout: [1, 1, 1], iout: [0, 0, 0] };
    const off = { t: [0, 1, 2], vin: [0, 0, 0], vout: [1.5, 1.5, 1.5], iout: [0, 0, 0] };
    expect(compareSeries(off, flat)).toBeCloseTo(0.5, 9);
  });

  it("is null when either side is empty", () => {
    const empty = { t: [], vin: [], vout: [], iout: [] };
    expect(compareSeries(empty, sineSeries())).toBeNull();
    expect(compareSeries(sineSeries(), empty)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// gradeCircuit, mode by mode
// ---------------------------------------------------------------------------

describe("gradeCircuit", () => {
  it("scores an unanswered question zero, and says so (F-GRADE-01)", () => {
    for (const answer of [null, { schematic: EMPTY_SCHEMATIC }] as (CircuitAnswer | null)[]) {
      const result = gradeCircuit(circuitConfig(), answer, ctx);
      expect(isGraded(result)).toBe(true);
      if (!isGraded(result)) return;
      expect(result.points).toBe(0);
      expect(result.state).toBe("validated");
      expect(result.details.reason).toBe("empty");
      expect(result.details.runner).toBe("none");
    }
  });

  it("hands a palette violation to a human rather than scoring it", () => {
    // The config's palette is R / C / L / GND: an op-amp cannot come from the
    // editor, so this answer is stale or tampered with.
    resetIds();
    const answer: CircuitAnswer = {
      schematic: { components: [component("OPAMP", "U1", 400, 160)], wires: [] },
    };
    const result = gradeCircuit(circuitConfig(), answer, ctx);
    expect(isGraded(result)).toBe(true);
    if (!isGraded(result)) return;
    expect(result.points).toBe(0);
    expect(result.state).toBe("proposed");
    expect(result.comment).toBe("palette_violation");
    expect(result.details.netlist.issues).toContain("kind_not_allowed:U1");
  });

  it("proposes a manual question with no stimulus, with the diagnostics attached", () => {
    const config = manual({ stimuli: [], reference: null, showExpected: false });
    const result = gradeCircuit(config, rcAnswer(), ctx);
    expect(isGraded(result)).toBe(true);
    if (!isGraded(result)) return;
    expect(result.points).toBe(0);
    expect(result.state).toBe("proposed");
    expect(result.details.runner).toBe("none");
    expect(result.details.reason).toBe("manual");
    expect(result.details.netlist.components).toBe(2);
    expect(result.details.netlist.issues).toEqual([]);
  });

  it("still runs a manual question that has stimuli, so the panel has the plots", () => {
    const result = gradeCircuit(manual(), rcAnswer(), ctx);
    expect(isPendingRunner(result)).toBe(true);
    if (!isPendingRunner(result)) return;
    expect(result.request.files.map((f) => f.name)).toEqual([
      "s0.cir",
      "s1.cir",
      "s2.cir",
      "r0.cir",
      "r1.cir",
      "r2.cir",
    ]);
    expect(result.request.priority).toBe("grading");
  });

  it("runs every stimulus, hidden ones included, in `simulation`", () => {
    const result = gradeCircuit(circuitConfig(), rcAnswer(), ctx);
    expect(isPendingRunner(result)).toBe(true);
    if (!isPendingRunner(result)) return;
    expect(result.request.cases.map((c) => c.name)).toEqual(["s0", "s1", "s2", "r0", "r1", "r2"]);
  });

  it("hands `llm` the rubric and the two netlists", () => {
    const config = circuitConfig({
      grading: { mode: "llm", tolerance: 0.05, rubric: SECRET_RUBRIC },
    });
    const result = gradeCircuit(config, rcAnswer(), ctx);
    expect(isPendingLlm(result)).toBe(true);
    if (!isPendingLlm(result)) return;
    expect(result.request.rubric).toBe(SECRET_RUBRIC);
    expect(result.request.maxPoints).toBe(8);
    expect(result.request.answer).toContain("R1 in out 1.59e+3");
    expect(result.request.reference).toContain("Rsecret");
  });

  it("falls back to a bare netlist for an `llm` question with no stimulus", () => {
    const config = circuitConfig({
      stimuli: [],
      showExpected: false,
      grading: { mode: "llm", tolerance: 0.05, rubric: SECRET_RUBRIC },
    });
    const result = gradeCircuit(config, rcAnswer(), ctx);
    expect(isPendingLlm(result)).toBe(true);
    if (!isPendingLlm(result)) return;
    expect(result.request.answer).not.toContain("Vin");
    expect(result.request.answer).toContain(".end");
  });
});

// ---------------------------------------------------------------------------
// finalizeRunnerCircuit
// ---------------------------------------------------------------------------

const reference = sineSeries({ amplitude: 0.7 });
const good = sineSeries({ amplitude: 0.7 });
const wrong = sineSeries({ amplitude: 0.2 });

describe("finalizeRunnerCircuit", () => {
  const config = circuitConfig();

  it("gives every point when every stimulus matches", () => {
    const result = finalizeRunnerCircuit(
      config,
      rcAnswer(),
      finalizeCtx,
      outcome([
        okCase(good),
        okCase(good),
        okCase(good),
        okCase(reference),
        okCase(reference),
        okCase(reference),
      ]),
    );
    expect(result.points).toBe(8);
    expect(result.state).toBe("validated");
    expect(result.details.earned).toBe(4);
    expect(result.details.total).toBe(4);
    expect(result.details.stimuli.map((s) => s.ok)).toEqual([true, true, true]);
    expect(result.details.stimuli[0]?.error).toBeCloseTo(0, 9);
  });

  it("fails the stimulus whose distance is past the tolerance", () => {
    const result = finalizeRunnerCircuit(
      config,
      rcAnswer(),
      finalizeCtx,
      outcome([
        okCase(good),
        okCase(wrong),
        okCase(good),
        okCase(reference),
        okCase(reference),
        okCase(reference),
      ]),
    );
    expect(result.details.stimuli.map((s) => s.ok)).toEqual([true, false, true]);
    expect(result.details.stimuli[1]?.error ?? 0).toBeGreaterThan(config.grading.tolerance);
    // 3 of the 4 points of the scale, on an item worth 8.
    expect(result.details.earned).toBe(3);
    expect(result.points).toBe(6);
    expect(result.state).toBe("validated");
  });

  it("fails a stimulus whose deck ngspice refused, and keeps the log", () => {
    const result = finalizeRunnerCircuit(
      config,
      rcAnswer(),
      finalizeCtx,
      outcome([
        failedCase("Error on line 3 : R1 in out\n"),
        okCase(good),
        okCase(good),
        okCase(reference),
        okCase(reference),
        okCase(reference),
      ]),
    );
    const first = result.details.stimuli[0];
    expect(first?.ok).toBe(false);
    expect(first?.reason).toBe("spice_failed");
    expect(first?.series).toBeNull();
    expect(first?.log).toContain("Error on line 3");
    expect((first?.log ?? "").length).toBeLessThanOrEqual(4001);
    expect(result.state).toBe("validated");
  });

  it("proposes rather than validates when the TEACHER's own deck failed", () => {
    const result = finalizeRunnerCircuit(
      config,
      rcAnswer(),
      finalizeCtx,
      outcome([
        okCase(good),
        okCase(good),
        okCase(good),
        failedCase(),
        okCase(reference),
        okCase(reference),
      ]),
    );
    expect(result.state).toBe("proposed");
    expect(result.comment).toBe("reference_failed");
    expect(result.details.stimuli[0]?.ok).toBe(false);
    expect(result.details.stimuli[0]?.reason).toBe("reference_failed");
  });

  it("scores a manual question zero and leaves the curves for the teacher", () => {
    const result = finalizeRunnerCircuit(
      manual(),
      rcAnswer(),
      finalizeCtx,
      outcome([
        okCase(good),
        okCase(good),
        okCase(good),
        okCase(reference),
        okCase(reference),
        okCase(reference),
      ]),
    );
    expect(result.points).toBe(0);
    expect(result.state).toBe("proposed");
    expect(result.details.earned).toBe(0);
    expect(result.details.stimuli[0]?.series).not.toBeNull();
    expect(result.details.stimuli[0]?.expected).not.toBeNull();
  });

  it("is defensive about an empty answer reaching the second half", () => {
    const result = finalizeRunnerCircuit(config, null, finalizeCtx, outcome([]));
    expect(result.points).toBe(0);
    expect(result.details.reason).toBe("empty");
  });
});

// ---------------------------------------------------------------------------
// parseSimulation
// ---------------------------------------------------------------------------

describe("parseSimulation", () => {
  const view = { seed: 1, itemId: "i", shuffle: false };

  it("agrees with the layout `interactiveRequest` asked for", () => {
    const config = circuitConfig();
    const student = circuitServer.toStudent(config, view);
    const request = interactiveRequest(config, rcAnswer());
    expect(request?.cases.map((c) => c.name)).toEqual(["s0", "s1"]);
    const results = parseSimulation(student, outcome([okCase(good), okCase(wrong)]));
    expect(results.map((r) => r.name)).toEqual(["1 kHz sine", "10 kHz sine"]);
    const first = results[0]?.series;
    expect(first != null && first.kind !== "ac" ? first.vout.length : -1).toBe(good.vout.length);
    expect(results[0]?.expected).toBeNull();
  });

  it("reads the reference cases when the question overlays them", () => {
    const config = circuitConfig({ showExpected: true });
    const student = circuitServer.toStudent(config, view);
    const request = interactiveRequest(config, rcAnswer());
    expect(request?.cases.map((c) => c.name)).toEqual(["s0", "s1", "r0", "r1"]);
    const results = parseSimulation(
      student,
      outcome([okCase(good), okCase(good), okCase(reference), okCase(reference)]),
    );
    expect(results).toHaveLength(2);
    expect(results[0]?.expected).not.toBeNull();
  });

  it("reports a failed deck instead of pretending there is a curve", () => {
    const student = circuitServer.toStudent(circuitConfig(), view);
    const results = parseSimulation(student, outcome([failedCase(), okCase(good)]));
    expect(results[0]?.series).toBeNull();
    expect(results[0]?.reason).toBe("spice_failed");
    expect(results[0]?.log).toContain("Error on line 3");
    expect(results[1]?.series).not.toBeNull();
  });

  it("says `not_run` for a case the runner never returned", () => {
    const student = circuitServer.toStudent(circuitConfig(), view);
    const results = parseSimulation(student, outcome([]));
    expect(results.map((r) => r.reason)).toEqual(["not_run", "not_run"]);
  });
});

// ---------------------------------------------------------------------------
// studentDetails
// ---------------------------------------------------------------------------

describe("studentDetails", () => {
  const config = circuitConfig();
  const details = finalizeRunnerCircuit(
    config,
    rcAnswer(),
    finalizeCtx,
    outcome([
      okCase(good),
      okCase(good),
      okCase(good),
      okCase(reference),
      okCase(reference),
      okCase(reference),
    ]),
  ).details;

  it("hides the hidden stimulus: its name, its curves and its log", () => {
    const view = studentDetails(details, { showKey: false, showHiddenCaseNames: false });
    const hidden = view.stimuli[2];
    expect(hidden?.name).toBe("#3");
    expect(hidden?.series).toBeNull();
    expect(hidden?.expected).toBeNull();
    // The verdict and the weight stay: a student must see what the scale was.
    expect(hidden?.ok).toBe(true);
    expect(hidden?.points).toBe(2);
    expect(JSON.stringify(view)).not.toContain(SECRET_HIDDEN_STIMULUS);
  });

  it("opens the hidden names when the policy does (docs/06 Q8)", () => {
    const view = studentDetails(details, { showKey: false, showHiddenCaseNames: true });
    expect(view.stimuli[2]?.name).toBe(SECRET_HIDDEN_STIMULUS);
    expect(view.stimuli[2]?.series).toBeNull();
  });

  it("keeps the expected curve of a VISIBLE stimulus only when the question publishes it", () => {
    const hiddenExpected = studentDetails(details, {
      showKey: false,
      showHiddenCaseNames: false,
    });
    expect(hiddenExpected.stimuli[0]?.expected).toBeNull();
    expect(hiddenExpected.stimuli[0]?.series).not.toBeNull();

    const overlaid = finalizeRunnerCircuit(
      circuitConfig({ showExpected: true }),
      rcAnswer(),
      finalizeCtx,
      outcome([
        okCase(good),
        okCase(good),
        okCase(good),
        okCase(reference),
        okCase(reference),
        okCase(reference),
      ]),
    ).details;
    const shown = studentDetails(overlaid, { showKey: false, showHiddenCaseNames: false });
    expect(shown.stimuli[0]?.expected).not.toBeNull();
    expect(shown.stimuli[2]?.expected).toBeNull();
  });

  it("passes the whole breakdown through once the key is published", () => {
    expect(studentDetails(details, { showKey: true, showHiddenCaseNames: false })).toBe(details);
  });
});

// ---------------------------------------------------------------------------
// The AC sweep: the envelope rule (ADR-040)
// ---------------------------------------------------------------------------

describe("wrapDegrees", () => {
  it("reduces a phase difference to (−180°, 180°]", () => {
    expect(wrapDegrees(0)).toBe(0);
    expect(wrapDegrees(360)).toBe(0);
    expect(wrapDegrees(-360)).toBe(0);
    expect(wrapDegrees(180)).toBe(180);
    expect(wrapDegrees(-180)).toBe(180);
    expect(wrapDegrees(190)).toBe(-170);
    expect(wrapDegrees(-345)).toBe(15);
  });
});

describe("compareBode", () => {
  const tolerance = { magDb: 1, floorDb: 60, phaseDeg: 10 };
  /** Three decades, the last one far under the floor (0 dB peak, −60 dB floor). */
  const reference = { kind: "ac" as const, f: [10, 100, 1000], magDb: [0, -20, -100], phaseDeg: [0, -90, -180] };
  const student = (magDb: number[], phaseDeg: number[] = reference.phaseDeg) => ({
    ...reference,
    magDb,
    phaseDeg,
  });

  it("puts a curve on itself inside the envelope", () => {
    expect(compareBode(reference, reference, tolerance)).toEqual({ worstDb: 0, worstDeg: 0, outside: 0 });
  });

  it("allows `magDb` either way above the floor, and not a hair more", () => {
    expect(compareBode(student([0.9, -20.9, -100]), reference, tolerance)?.outside).toBe(0);
    const off = compareBode(student([1.2, -18, -100]), reference, tolerance);
    expect(off?.outside).toBe(2);
    expect(off?.worstDb).toBeCloseTo(2, 9);
  });

  it("is one-sided below the floor: any output low enough passes there, and its phase is noise", () => {
    // The reference is at −100 dB, under the −60 dB floor: −70 dB is "nothing
    // gets through" too, and the phase down there is not compared.
    const quiet = compareBode(student([0, -20, -70], [0, -90, 0]), reference, tolerance);
    expect(quiet?.outside).toBe(0);
    expect(quiet?.worstDeg).toBe(0);
    // −58 dB rises past floor + magDb (−59 dB).
    const leaky = compareBode(student([0, -20, -58]), reference, tolerance);
    expect(leaky?.outside).toBe(1);
    expect(leaky?.worstDb).toBeCloseTo(2, 9);
  });

  it("measures the floor from the reference's own peak, not from 0 dB", () => {
    const amplifier = { ...reference, magDb: [40, 20, -60] };
    // Peak 40 dB, floor −20 dB: −60 is below it, so −25 is quiet enough.
    expect(compareBode({ ...amplifier, magDb: [40, 20, -25] }, amplifier, tolerance)?.outside).toBe(0);
  });

  it("compares the phase modulo 360°, within `phaseDeg`", () => {
    const inverting = { ...reference, magDb: [20, 20, 20], phaseDeg: [180, 180, 180] };
    // −180° is 180° by another name.
    expect(compareBode({ ...inverting, phaseDeg: [-180, 540, 175] }, inverting, tolerance)?.outside).toBe(0);
    // −175° is 5° past 180°, across the wrap: inside, and measured as 5°.
    const late = compareBode({ ...inverting, phaseDeg: [180, -175, 180] }, inverting, tolerance);
    expect(late?.outside).toBe(0);
    expect(late?.worstDeg).toBeCloseTo(5, 9);
    const wrong = compareBode({ ...inverting, phaseDeg: [180, 165, 180] }, inverting, tolerance);
    expect(wrong?.outside).toBe(1);
    expect(wrong?.worstDeg).toBeCloseTo(15, 9);
  });

  it("does not look at the phase when it is switched off", () => {
    const envelope = compareBode(student([0, -20, -100], [90, 0, 0]), reference, { ...tolerance, phaseDeg: null });
    expect(envelope).toEqual({ worstDb: 0, worstDeg: null, outside: 0 });
  });

  it("refuses to compare two sweeps on different grids", () => {
    expect(compareBode({ ...reference, f: [10, 100] , magDb: [0, -20], phaseDeg: [0, -90] }, reference, tolerance)).toBeNull();
    expect(compareBode({ ...reference, f: [10, 100, 2000] }, reference, tolerance)).toBeNull();
  });
});

describe("finalizeRunnerCircuit, AC", () => {
  const acConfig = (analysis = { kind: "ac", fStartHz: 10, fStopHz: 1e5, pointsPerDecade: 10 }) =>
    circuitConfig({
      stimuli: [
        { name: "Bode", source: { kind: "dc", volts: 0 }, load: { kind: "open" }, analysis, points: 1 },
        {
          name: SECRET_HIDDEN_STIMULUS,
          source: { kind: "dc", volts: 0 },
          load: { kind: "open" },
          analysis,
          points: 1,
          visible: false,
        },
      ],
      grading: {
        mode: "simulation",
        tolerance: 0.05,
        bode: { magDb: 1, floorDb: 60, phaseDeg: 10 },
        rubric: "",
      },
    });
  const reference = lowPassBode();

  it("passes a Bode plot inside the envelope and records how far inside", () => {
    const close = lowPassBode({ cornerHz: 1050 });
    const result = finalizeRunnerCircuit(
      acConfig(),
      rcAnswer(),
      finalizeCtx,
      outcome([okCase(close), okCase(close), okCase(reference), okCase(reference)]),
    );
    expect(result.state).toBe("validated");
    expect(result.points).toBe(8);
    const first = result.details.stimuli[0];
    expect(first?.ok).toBe(true);
    // Never a percentage of a swing: the AC verdict is in dB and degrees.
    expect(first?.error).toBeNull();
    expect(first?.envelope?.outside).toBe(0);
    expect(first?.envelope?.worstDb).toBeCloseTo(20 * Math.log10(1.05), 2);
    expect(first?.series?.kind).toBe("ac");
    expect(first?.expected?.kind).toBe("ac");
  });

  it("fails a corner frequency twice too high", () => {
    const wrong = lowPassBode({ cornerHz: 2000 });
    const result = finalizeRunnerCircuit(
      acConfig(),
      rcAnswer(),
      finalizeCtx,
      outcome([okCase(wrong), okCase(reference), okCase(reference), okCase(reference)]),
    );
    expect(result.details.stimuli.map((s) => s.ok)).toEqual([false, true]);
    expect(result.points).toBe(4);
    expect(result.details.stimuli[0]?.envelope?.outside).toBeGreaterThan(0);
  });

  it("judges the FULL sweep: a spike that decimation would step over still fails", () => {
    const analysis = { kind: "ac", fStartHz: 1, fStopHz: 1e9, pointsPerDecade: 200 };
    const full = lowPassBode({ fStart: 1, fStop: 1e9, perDecade: 200, cornerHz: 1e6 });
    expect(full.f).toHaveLength(1801);
    // Index 3 is not among the 250 samples `decimate` keeps (0, 7, 14…).
    const spiked = { ...full, magDb: full.magDb.map((v, i) => (i === 3 ? v + 5 : v)) };
    const result = finalizeRunnerCircuit(
      acConfig(analysis),
      rcAnswer(),
      finalizeCtx,
      outcome([okCase(spiked), okCase(full), okCase(full), okCase(full)]),
    );
    const first = result.details.stimuli[0];
    expect(first?.ok).toBe(false);
    expect(first?.envelope?.outside).toBe(1);
    // What is STORED is decimated all the same.
    expect(first?.series?.kind === "ac" ? first.series.f.length : 0).toBe(250);
  });

  it("fails, with a reason, a sweep that does not sit on the reference's grid", () => {
    const coarse = lowPassBode({ perDecade: 5 });
    const result = finalizeRunnerCircuit(
      acConfig(),
      rcAnswer(),
      finalizeCtx,
      outcome([okCase(coarse), okCase(reference), okCase(reference), okCase(reference)]),
    );
    expect(result.details.stimuli[0]?.ok).toBe(false);
    expect(result.details.stimuli[0]?.reason).toBe("grid_mismatch");
  });

  it("keeps a hidden sweep's verdict for the student, and drops its curves", () => {
    const details = finalizeRunnerCircuit(
      acConfig(),
      rcAnswer(),
      finalizeCtx,
      outcome([okCase(reference), okCase(reference), okCase(reference), okCase(reference)]),
    ).details;
    const view = studentDetails(details, { showKey: false, showHiddenCaseNames: false });
    expect(view.stimuli[1]?.series).toBeNull();
    expect(view.stimuli[1]?.expected).toBeNull();
    expect(view.stimuli[1]?.envelope).toEqual({ worstDb: 0, worstDeg: 0, outside: 0 });
    // The reference's curve of the visible sweep only travels under `showExpected`.
    expect(view.stimuli[0]?.expected).toBeNull();
  });

  it("grades a config stored before the AC sweep as the transients it holds", () => {
    const stored = storedBeforeAc();
    const pending = gradeCircuit(stored, rcAnswer(), ctx);
    expect(isPendingRunner(pending)).toBe(true);
    if (!isPendingRunner(pending)) return;
    expect(pending.request.files.every((f) => f.content.includes(".tran "))).toBe(true);
    const wave = okCase(sineSeries({ amplitude: 0.7 }));
    const result = finalizeRunnerCircuit(
      stored,
      rcAnswer(),
      finalizeCtx,
      outcome([wave, wave, wave, wave, wave, wave]),
    );
    expect(result.details.stimuli.map((s) => s.ok)).toEqual([true, true, true]);
    expect(result.details.stimuli[0]?.envelope).toBeUndefined();
  });

  it("reads the student's own Simulate outcome as a Bode plot", () => {
    const config = acConfig();
    const results = parseSimulation(
      circuitServer.toStudent(config, { seed: 1, itemId: "i", shuffle: false }),
      outcome([okCase(reference)]),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.series?.kind).toBe("ac");
  });
});
