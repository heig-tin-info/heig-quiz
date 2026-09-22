/**
 * Grading of a `circuit` question, in two halves (decision D2, like `code`).
 *
 * `gradeCircuit` decides nothing that needs a simulation: it extracts the
 * netlist, checks what can be checked on the schematic alone, and hands back
 * a `pending: runner` result carrying decks it built ITSELF from the stored
 * answer (invariant 14). `finalizeRunnerCircuit` is the pure second half —
 * every verdict rule is unit-testable against a fixture `RunnerOutcome`.
 *
 * This module is imported by BOTH entry points: `parseSimulation` is what the
 * player calls on the outcome of the student's own Simulate button, so
 * nothing here may reach for `node:`. Anything server-only belongs in
 * `server.ts`.
 */
import type { FinalizeContext, GradeContext, GradeResult, GradedResult } from "@quiz/core/server";
import { RunnerRequest, type RunnerOutcome } from "@quiz/core/server";
import { round2 } from "@quiz/domain";

import { extractNets, formatIssue, hasPaletteViolation } from "./netlist.js";
import { buildBareNetlist, buildNetlist, decimate, parseSpiceOutput, type Harness } from "./spice.js";
import {
  totalStimulusPoints,
  type CircuitAnswer,
  type CircuitConfig,
  type CircuitDetails,
  type CircuitStudent,
  type SeriesSet,
  type StimulusDetail,
} from "./schema.js";

/** Runner output kept in `gradings.details` is capped: a 64 KB log is not a grade. */
const LOG_CHARS = 4000;

/** ngspice is a few hundred lines of C on a 500-point transient: ten seconds is generous. */
export const SPICE_LIMITS = { timeMs: 10_000, memoryMb: 256, outputKb: 256 } as const;

const tail = (s: string, max = LOG_CHARS): string => (s.length <= max ? s : `…${s.slice(-max)}`);

/** True when the student drew nothing at all (F-GRADE-01: zero points). */
export function isEmptyAnswer(answer: CircuitAnswer | null): boolean {
  return (
    answer === null ||
    (answer.schematic.components.length === 0 && answer.schematic.wires.length === 0)
  );
}

const harnessOf = (config: CircuitConfig): Harness => ({
  supplies: config.supplies,
  commonGround: config.commonGround,
});

// ---------------------------------------------------------------------------
// The runner request
// ---------------------------------------------------------------------------

/**
 * Which case of a {@link RunnerOutcome} is which.
 *
 * `RunnerOutcome.cases` is a flat list in request order, so both halves of
 * the package need the SAME rule to read it back: student decks first, one
 * per requested stimulus, then the reference decks in the same order. The
 * layout is computed without building a single netlist, which is what lets
 * `finalizeRunnerCircuit` stay cheap and the client agree with the server.
 */
export interface CaseLayout {
  name: string;
  stimulusIndex: number;
  role: "student" | "reference";
}

export interface BuildRequestOptions {
  priority: "grading" | "interactive";
  stimulusIndexes: number[];
  withReference: boolean;
}

/** The case list of a request, without the decks. */
export function caseLayout(config: CircuitConfig, options: BuildRequestOptions): CaseLayout[] {
  const indexes = options.stimulusIndexes.filter((i) => config.stimuli[i] !== undefined);
  const student: CaseLayout[] = indexes.map((i) => ({
    name: `s${i}`,
    stimulusIndex: i,
    role: "student",
  }));
  if (!options.withReference || config.reference === null) return student;
  return [
    ...student,
    ...indexes.map<CaseLayout>((i) => ({ name: `r${i}`, stimulusIndex: i, role: "reference" })),
  ];
}

/**
 * The request the runner receives: one deck per case, the deck's file name in
 * `args` because the runner's `spice` plan is `ngspice -b <args>`.
 *
 * `RunnerRequest.files` holds at most eight entries and a config at most four
 * stimuli, so a student run and a reference run of every stimulus fits
 * exactly — that is why the cap is four and not five.
 */
export function buildRunnerRequest(
  config: CircuitConfig,
  answer: CircuitAnswer,
  options: BuildRequestOptions,
): { request: RunnerRequest; layout: CaseLayout[] } {
  const harness = harnessOf(config);
  const layout = caseLayout(config, options);
  const files = layout.map((entry) => {
    const stimulus = config.stimuli[entry.stimulusIndex];
    const schematic =
      entry.role === "student" ? answer.schematic : (config.reference ?? answer.schematic);
    const content =
      stimulus === undefined ? "" : buildNetlist(schematic, stimulus, harness).text;
    return { name: `${entry.name}.cir`, content };
  });
  const request = RunnerRequest.parse({
    language: "spice",
    files,
    compileArgs: "",
    action: "run",
    limits: { ...SPICE_LIMITS },
    cases: layout.map((entry) => ({ name: entry.name, args: [`${entry.name}.cir`], stdin: "" })),
    priority: options.priority,
  });
  return { request, layout };
}

/**
 * The request behind the student's Simulate button: the VISIBLE stimuli only,
 * and the reference decks only when the teacher publishes the expected curve.
 * `null` when there is nothing to run.
 */
export function interactiveRequest(
  config: CircuitConfig,
  answer: CircuitAnswer,
): RunnerRequest | null {
  if (isEmptyAnswer(answer)) return null;
  const visible = config.stimuli.flatMap((s, i) => (s.visible ? [i] : []));
  if (visible.length === 0) return null;
  return buildRunnerRequest(config, answer, {
    priority: "interactive",
    stimulusIndexes: visible,
    withReference: config.showExpected,
  }).request;
}

// ---------------------------------------------------------------------------
// Comparing two waveforms
// ---------------------------------------------------------------------------

/** Linear interpolation of `y(x)` on a sorted `xs`, clamped outside the range. */
function interpolate(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  const first = xs[0];
  const last = xs[n - 1];
  if (n === 0 || first === undefined || last === undefined) return 0;
  if (x <= first) return ys[0] ?? 0;
  if (x >= last) return ys[n - 1] ?? 0;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const xm = xs[mid];
    if (xm === undefined) break;
    if (xm <= x) lo = mid;
    else hi = mid;
  }
  const x0 = xs[lo];
  const x1 = xs[hi];
  const y0 = ys[lo] ?? 0;
  const y1 = ys[hi] ?? 0;
  if (x0 === undefined || x1 === undefined || x1 === x0) return y0;
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

/**
 * How far the student's output is from the reference's, as a fraction of the
 * reference's own swing.
 *
 * The two runs do not share a time grid — a different circuit converges at a
 * different pace — so the student's curve is resampled onto the reference's
 * instants and the RMS of the difference is taken there. Dividing by the
 * peak-to-peak makes the number comparable across questions: 0.05 means "five
 * percent of the expected swing", whatever the volts are. A reference that
 * does not move (a constant output) divides by 1, which turns the tolerance
 * into an absolute one in volts rather than a division by nothing.
 */
export function compareSeries(student: SeriesSet, expected: SeriesSet): number | null {
  if (student.t.length === 0 || expected.t.length === 0) return null;
  let sum = 0;
  for (const [i, t] of expected.t.entries()) {
    const want = expected.vout[i] ?? 0;
    const got = interpolate(student.t, student.vout, t);
    sum += (got - want) ** 2;
  }
  const rms = Math.sqrt(sum / expected.t.length);
  const swing = Math.max(...expected.vout) - Math.min(...expected.vout);
  return rms / (swing < 1e-9 ? 1 : swing);
}

// ---------------------------------------------------------------------------
// Reading a runner outcome
// ---------------------------------------------------------------------------

/** One simulated stimulus, as the player draws it. */
export interface SimulationResult {
  name: string;
  series: SeriesSet | null;
  expected: SeriesSet | null;
  reason?: string;
  log?: string;
}

interface CaseReading {
  series: SeriesSet | null;
  reason?: string;
  log?: string;
}

/** One case of an outcome: the table it printed, or why there is none. */
function readCase(run: RunnerOutcome["cases"][number] | undefined): CaseReading {
  if (run === undefined) return { series: null, reason: "not_run" };
  const parsed = parseSpiceOutput(run.stdout);
  if (parsed !== null && run.exitCode === 0 && !run.timedOut) {
    return { series: decimate(parsed) };
  }
  // ngspice exits 0 after refusing a deck, so a missing table is as much a
  // failure as a non-zero exit; the tail of both streams is what tells the
  // teacher which line it choked on.
  return {
    series: null,
    reason: run.timedOut ? "spice_timeout" : "spice_failed",
    log: tail(`${run.stderr}\n${run.stdout}`.trim()),
  };
}

/**
 * The outcome of {@link interactiveRequest}, read with the SAME layout rule:
 * the visible stimuli of the student view, in order, then the reference decks
 * when the teacher publishes them. The student view is the only thing the
 * browser has, which is why this takes it rather than the config.
 */
export function parseSimulation(
  student: CircuitStudent,
  outcome: RunnerOutcome,
): SimulationResult[] {
  const n = student.visibleStimuli.length;
  return student.visibleStimuli.map((stimulus, k) => {
    const read = readCase(outcome.cases[k]);
    const reference = student.showExpected ? readCase(outcome.cases[n + k]) : null;
    return {
      name: stimulus.name,
      series: read.series,
      expected: reference?.series ?? null,
      ...(read.reason === undefined ? {} : { reason: read.reason }),
      ...(read.log === undefined ? {} : { log: read.log }),
    };
  });
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

interface Diagnosis {
  netlist: CircuitDetails["netlist"];
  paletteViolation: boolean;
}

function diagnose(config: CircuitConfig, answer: CircuitAnswer | null): Diagnosis {
  if (answer === null) {
    return { netlist: { components: 0, nets: 0, issues: [] }, paletteViolation: false };
  }
  const extracted = extractNets(answer.schematic, {
    commonGround: config.commonGround,
    palette: config.palette,
    supplies: config.supplies,
  });
  return {
    netlist: {
      components: extracted.counted,
      nets: extracted.nets.length,
      issues: extracted.issues.map(formatIssue),
    },
    paletteViolation: hasPaletteViolation(extracted.issues),
  };
}

function baseDetails(
  config: CircuitConfig,
  diagnosis: Diagnosis,
  runner: CircuitDetails["runner"],
): CircuitDetails {
  return {
    mode: config.grading.mode,
    runner,
    netlist: diagnosis.netlist,
    stimuli: [],
    earned: 0,
    total: totalStimulusPoints(config),
    showExpected: config.showExpected,
  };
}

/**
 * First half. Nothing but the schematic is known here, so the only verdicts
 * it reaches are the ones a simulation cannot change: an empty answer, and an
 * answer that no longer fits the question's own palette.
 */
export function gradeCircuit(
  config: CircuitConfig,
  answer: CircuitAnswer | null,
  ctx: GradeContext,
): GradeResult<CircuitDetails> {
  const diagnosis = diagnose(config, answer);

  if (isEmptyAnswer(answer)) {
    return {
      kind: "graded",
      points: 0,
      maxPoints: ctx.itemPoints,
      details: { ...baseDetails(config, diagnosis, "none"), reason: "empty" },
      state: "validated",
    };
  }
  const drawn = answer as CircuitAnswer;

  if (diagnosis.paletteViolation) {
    // More components than the palette allows, or a kind it never offered:
    // the editor cannot produce this, so the answer is stale (the teacher
    // tightened the palette) or tampered with. Either way a human decides.
    return {
      kind: "graded",
      points: 0,
      maxPoints: ctx.itemPoints,
      details: { ...baseDetails(config, diagnosis, "none"), reason: "palette_violation" },
      state: "proposed",
      comment: "palette_violation",
    };
  }

  if (config.grading.mode === "llm") {
    // Phase 2. The MVP grading worker rejects this with `llm_unavailable`.
    const harness = harnessOf(config);
    const first = config.stimuli[0];
    const studentText =
      first === undefined
        ? buildBareNetlist(drawn.schematic, harness).text
        : buildNetlist(drawn.schematic, first, harness).text;
    const referenceText =
      config.reference === null
        ? undefined
        : first === undefined
          ? buildBareNetlist(config.reference, harness).text
          : buildNetlist(config.reference, first, harness).text;
    return {
      kind: "pending",
      via: "llm",
      request: {
        rubric: config.grading.rubric,
        ...(referenceText === undefined ? {} : { reference: referenceText }),
        answer: studentText,
        maxPoints: ctx.itemPoints,
      },
    };
  }

  const indexes = config.stimuli.map((_stimulus, i) => i);

  if (config.grading.mode === "manual" && indexes.length === 0) {
    // Nothing to run and nothing to compare: the teacher grades the drawing.
    return {
      kind: "graded",
      points: 0,
      maxPoints: ctx.itemPoints,
      details: { ...baseDetails(config, diagnosis, "none"), reason: "manual" },
      state: "proposed",
    };
  }

  // `manual` with stimuli still goes through the runner: the grading panel is
  // far more useful with the student's and the teacher's curves side by side
  // than with a schematic alone.
  const withReference =
    config.grading.mode === "simulation" ? true : config.reference !== null;

  try {
    const { request } = buildRunnerRequest(config, drawn, {
      priority: "grading",
      stimulusIndexes: indexes,
      withReference,
    });
    return { kind: "pending", via: "runner", request };
  } catch {
    // An oversized deck: the runner would refuse it anyway.
    return {
      kind: "graded",
      points: 0,
      maxPoints: ctx.itemPoints,
      details: { ...baseDetails(config, diagnosis, "error"), reason: "runner_request_invalid" },
      state: "proposed",
      comment: "runner_request_invalid",
    };
  }
}

/**
 * Second half: the runner has spoken. Pure, total, and the only place a
 * `circuit` score is decided.
 */
export function finalizeRunnerCircuit(
  config: CircuitConfig,
  answer: CircuitAnswer | null,
  ctx: FinalizeContext,
  outcome: RunnerOutcome,
): GradedResult<CircuitDetails> {
  const diagnosis = diagnose(config, answer);
  const total = totalStimulusPoints(config);

  if (isEmptyAnswer(answer)) {
    return {
      kind: "graded",
      points: 0,
      maxPoints: ctx.itemPoints,
      details: { ...baseDetails(config, diagnosis, "none"), reason: "empty" },
      state: "validated",
    };
  }

  const simulation = config.grading.mode === "simulation";
  const withReference = simulation ? true : config.reference !== null;
  const layout = caseLayout(config, {
    priority: "grading",
    stimulusIndexes: config.stimuli.map((_stimulus, i) => i),
    withReference,
  });
  const indexOf = (role: CaseLayout["role"], stimulusIndex: number): number =>
    layout.findIndex((l) => l.role === role && l.stimulusIndex === stimulusIndex);

  let referenceFailed = false;
  const stimuli: StimulusDetail[] = config.stimuli.map((stimulus, i) => {
    const student = readCase(outcome.cases[indexOf("student", i)]);
    const expectedIndex = indexOf("reference", i);
    const reference = expectedIndex < 0 ? null : readCase(outcome.cases[expectedIndex]);
    if (reference !== null && reference.series === null) referenceFailed = true;

    const error =
      student.series !== null && reference?.series != null
        ? compareSeries(student.series, reference.series)
        : null;
    const ok =
      student.series !== null &&
      (reference === null || (error !== null && error <= config.grading.tolerance));
    const reason =
      student.reason ??
      (reference !== null && reference.series === null ? "reference_failed" : undefined);

    return {
      name: stimulus.name,
      visible: stimulus.visible,
      points: stimulus.points,
      ok,
      error,
      series: student.series,
      expected: reference?.series ?? null,
      ...(reason === undefined ? {} : { reason }),
      ...(student.log === undefined ? {} : { log: student.log }),
    };
  });

  const earned = stimuli.reduce((sum, s) => (s.ok ? sum + s.points : sum), 0);
  const details: CircuitDetails = {
    ...baseDetails(config, diagnosis, "ok"),
    stimuli,
    earned: simulation ? earned : 0,
    total,
  };

  if (!simulation) {
    // `manual`: the curves are there for the teacher's eyes, and `ok` is
    // informational only. The score is theirs to set.
    return {
      kind: "graded",
      points: 0,
      maxPoints: ctx.itemPoints,
      details,
      state: "proposed",
    };
  }

  const points = round2(total > 0 ? (earned / total) * ctx.itemPoints : 0);
  if (referenceFailed) {
    // The TEACHER's own circuit did not simulate: whatever the comparison
    // says, it compared against nothing. Never validate that automatically.
    return {
      kind: "graded",
      points,
      maxPoints: ctx.itemPoints,
      details: { ...details, reason: "reference_failed" },
      state: "proposed",
      comment: "reference_failed",
    };
  }
  return { kind: "graded", points, maxPoints: ctx.itemPoints, details, state: "validated" };
}

// ---------------------------------------------------------------------------
// What a student may read of the breakdown
// ---------------------------------------------------------------------------

/**
 * The breakdown as a STUDENT may read it (docs/spec/05 §5.7, decision D15).
 *
 * A hidden stimulus keeps its verdict and its weight — a student must be able
 * to see what the scale was made of — and loses its name, its waveforms and
 * anything ngspice printed: the source, the load and the analysis window of a
 * hidden stimulus are part of the key, and a plot spells them out.
 *
 * The reference's curve is published only when the teacher says so: either
 * the whole key is out (`showKey`) or the question overlays the expected
 * output on the visible stimuli (`config.showExpected`, carried in the
 * details because this hook only ever sees the details).
 */
export function studentDetails(
  details: CircuitDetails,
  policy: { showKey: boolean; showHiddenCaseNames: boolean },
): CircuitDetails {
  if (policy.showKey) return details;
  return {
    ...details,
    stimuli: details.stimuli.map((s, i) => {
      if (!s.visible) {
        return {
          name: policy.showHiddenCaseNames ? s.name : `#${i + 1}`,
          visible: false,
          points: s.points,
          ok: s.ok,
          error: s.error,
          series: null,
          expected: null,
          ...(s.reason === undefined ? {} : { reason: s.reason }),
        };
      }
      return {
        ...s,
        expected: details.showExpected === true ? s.expected : null,
      };
    }),
  };
}
