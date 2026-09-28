/**
 * `@quiz/qt-circuit/server` — the server half of the `circuit` question type.
 *
 * No React, anywhere in this module graph: the API imports it through
 * `@quiz/registry/server`. What crosses the package boundary is named one by
 * one below: the library, the schemas, the extractor and the emitter stay
 * internal, because nothing outside the package reads them.
 */
import type { FinalizeContext, GradeContext, QuestionTypeServer } from "@quiz/core/server";
import { reparseMigrate, type RunnerOutcome } from "@quiz/core/server";

import { fromCanonical, toCanonical } from "./canonical.js";
import {
  finalizeRunnerCircuit,
  gradeCircuit,
  interactiveRequest,
  studentDetails,
} from "./grade.js";
import {
  CIRCUIT_CONFIG_VERSION,
  CircuitAnswer,
  CircuitConfig,
  CircuitDetails,
  CircuitSolution,
  CircuitStudent,
  emptyCircuitConfig,
  totalStimulusPoints,
} from "./schema.js";
import { isCircuitAnswered } from "./schema.js";

export const circuitServer: QuestionTypeServer<
  CircuitConfig,
  CircuitAnswer,
  CircuitStudent,
  CircuitSolution,
  CircuitDetails
> = {
  id: "circuit",
  configVersion: CIRCUIT_CONFIG_VERSION,

  configSchema: CircuitConfig,
  answerSchema: CircuitAnswer,
  isAnswered: isCircuitAnswered,
  studentSchema: CircuitStudent,
  solutionSchema: CircuitSolution,
  detailsSchema: CircuitDetails,

  emptyDraft: emptyCircuitConfig,

  migrate: reparseMigrate("circuit", CircuitConfig, CIRCUIT_CONFIG_VERSION),

  /** The stimuli carry the weight of the question; a teacher may still override it. */
  defaultPoints(config) {
    const total = totalStimulusPoints(config);
    return total > 0 ? total : 1;
  },

  /** Nothing to shuffle: a schematic has no order and the stimuli are the teacher's. */
  shuffleable() {
    return false;
  },

  /**
   * THE single content exit (invariant 4). What stays behind: the reference
   * schematic, the hidden stimuli, the tolerance, the rubric and the grading
   * mode — a student who knows the mode knows whether the netlist is compared
   * at all.
   */
  toStudent(config) {
    const visible = config.stimuli.filter((s) => s.visible);
    const hidden = config.stimuli.filter((s) => !s.visible);
    return {
      prompt: config.prompt,
      palette: { kinds: [...config.palette.kinds], maxComponents: config.palette.maxComponents },
      supplies: { ...config.supplies },
      commonGround: config.commonGround,
      visibleStimuli: visible.map((s) => ({
        name: s.name,
        source: { ...s.source },
        sourceOhms: s.sourceOhms,
        load: { ...s.load },
        analysis: { ...s.analysis },
        points: s.points,
      })),
      hiddenCount: hidden.length,
      hiddenPoints: hidden.reduce((sum, s) => sum + s.points, 0),
      // No visible stimulus means no harness to run the schematic in, so the
      // Simulate button has nothing to ask for and does not exist.
      canSimulate: visible.length > 0,
      showExpected: config.showExpected,
      simulationsPerMinute: config.simulationsPerMinute,
    };
  },

  toSolution(config) {
    return {
      reference: config.reference,
      stimuli: config.stimuli,
      grading: { ...config.grading },
    };
  },

  studentDetails(details: CircuitDetails, policy): unknown {
    return studentDetails(details, {
      showKey: policy.showKey,
      showHiddenCaseNames: policy.showHiddenCaseNames,
    });
  },

  /** One cell of the live dashboard: the size of the drawing, never its worth. */
  summarizeAnswer(_config, answer) {
    const { components, wires } = answer.schematic;
    return `${components.length} parts · ${wires.length} wires`;
  },

  interactiveRequest(config: CircuitConfig, answer: CircuitAnswer) {
    return interactiveRequest(config, answer);
  },

  grade(config: CircuitConfig, answer: CircuitAnswer | null, ctx: GradeContext) {
    return gradeCircuit(config, answer, ctx);
  },

  finalizeRunner(
    config: CircuitConfig,
    answer: CircuitAnswer | null,
    ctx: FinalizeContext,
    outcome: RunnerOutcome,
  ) {
    return finalizeRunnerCircuit(config, answer, ctx, outcome);
  },

  /** Indexed: what a teacher would type to find the question again. */
  searchText(config) {
    return [config.prompt, "circuit", ...config.stimuli.map((s) => s.name)].join(" ");
  },

  toCanonical,
  fromCanonical,
};

/*
 * The pure parts a host reads beside `circuitServer`: `parseSimulation` reads
 * the outcome of the student's own Simulate button, and `extractNets` the
 * netlist the grade is computed from (ADR-019 §3, invariant 14) — a server
 * concern, so it leaves the package here and not through `./client`.
 */
export { parseSimulation } from "./grade.js";
export { extractNets } from "./netlist.js";
