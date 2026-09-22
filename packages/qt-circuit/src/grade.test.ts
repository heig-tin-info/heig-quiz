import { describe, expect, it } from "vitest";

import type { FinalizeContext, GradeContext, RunnerService } from "@quiz/core/server";
import { isGraded, isPendingLlm, isPendingRunner } from "@quiz/core/server";

import {
  buildRunnerRequest,
  caseLayout,
  compareSeries,
  finalizeRunnerCircuit,
  gradeCircuit,
  interactiveRequest,
  isEmptyAnswer,
  parseSimulation,
  studentDetails,
} from "./grade.js";
import { circuitServer } from "./server.js";
import { EMPTY_SCHEMATIC, type CircuitAnswer, type CircuitConfig } from "./schema.js";
import {
  SECRET_HIDDEN_STIMULUS,
  SECRET_RUBRIC,
  circuitConfig,
  component,
  failedCase,
  okCase,
  outcome,
  rcAnswer,
  resetIds,
  sineSeries,
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
    expect(results[0]?.series?.vout.length).toBe(good.vout.length);
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
