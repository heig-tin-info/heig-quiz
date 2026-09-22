/**
 * `@quiz/qt-circuit/server` — the server half of the `circuit` question type.
 *
 * No React, anywhere in this module graph: the API imports it through
 * `@quiz/registry/server`. It also re-exports the pure halves of the package
 * — the library, the schemas, the extractor, the emitter and the parts of
 * `grade.ts` a browser needs — so that `./client` has one place to take them
 * from and the two halves cannot drift apart.
 */
import type { FinalizeContext, GradeContext, QuestionTypeServer } from "@quiz/core/server";
import { ConfigMigrationError, type RunnerOutcome } from "@quiz/core/server";

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
  studentSchema: CircuitStudent,
  solutionSchema: CircuitSolution,
  detailsSchema: CircuitDetails,

  emptyDraft: emptyCircuitConfig,

  migrate(config: unknown, fromVersion: number): CircuitConfig {
    if (fromVersion > CIRCUIT_CONFIG_VERSION) {
      throw new ConfigMigrationError(
        "circuit",
        fromVersion,
        CIRCUIT_CONFIG_VERSION,
        "config written by a newer version of the platform",
      );
    }
    // A config already at the current version is returned as it stands, like
    // the other types do: a DRAFT may be invalid (decision D16 — the empty
    // draft has no prompt), and the contract says `migrate` never throws on a
    // config the type emitted. Parsing is for the versions that changed shape.
    if (fromVersion === CIRCUIT_CONFIG_VERSION) return config as CircuitConfig;
    const source = typeof config === "object" && config !== null ? config : {};
    const parsed = CircuitConfig.safeParse({ ...source, configVersion: CIRCUIT_CONFIG_VERSION });
    if (!parsed.success) {
      throw new ConfigMigrationError(
        "circuit",
        fromVersion,
        CIRCUIT_CONFIG_VERSION,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }
    return parsed.data;
  },

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

export * from "./library.js";
export * from "./netlist.js";
export * from "./schema.js";
export * from "./spice.js";
export { fromCanonical, toCanonical } from "./canonical.js";
/*
 * The pure parts of the grader. `parseSimulation` reads the outcome of the
 * student's own Simulate button, so the browser half needs it; the rest of
 * `grade.ts` is server work but carries no Node import, which is why the
 * whole module sits on one side of the fence and only these names cross it.
 */
export {
  buildRunnerRequest,
  caseLayout,
  compareSeries,
  finalizeRunnerCircuit,
  gradeCircuit,
  interactiveRequest,
  isEmptyAnswer,
  parseSimulation,
  studentDetails,
  SPICE_LIMITS,
} from "./grade.js";
export type { BuildRequestOptions, CaseLayout, SimulationResult } from "./grade.js";
