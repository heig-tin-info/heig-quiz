/**
 * The server half of the `logic` question type (docs/spec/04 §4.18,
 * ADR-123), the second type of this package (ADR-021 §1). No React: the API
 * reaches it through `@quiz/qt-circuit/server`.
 */
import type { QuestionTypeServer } from "@quiz/core/server";
import { reparseMigrate } from "@quiz/core/server";

import { gradeLogic, logicStudentDetails } from "./logicGrade.js";
import {
  emptyLogicConfig,
  isGateKind,
  isLogicAnswered,
  LOGIC_CONFIG_VERSION,
  LogicAnswer,
  LogicConfig,
  LogicDetails,
  LogicSolution,
  LogicStudent,
} from "./logicSchema.js";

export const logicServer: QuestionTypeServer<LogicConfig, LogicAnswer, LogicStudent, LogicSolution, LogicDetails> = {
  id: "logic",
  configVersion: LOGIC_CONFIG_VERSION,

  configSchema: LogicConfig,
  answerSchema: LogicAnswer,
  isAnswered: isLogicAnswered,
  studentSchema: LogicStudent,
  solutionSchema: LogicSolution,
  detailsSchema: LogicDetails,

  emptyDraft: emptyLogicConfig,
  migrate: reparseMigrate("logic", LogicConfig, LOGIC_CONFIG_VERSION),

  defaultPoints: () => 1,

  /** Nothing to shuffle: a schematic has no order. */
  shuffleable: () => false,

  /**
   * THE single content exit (invariant 4): the statement, the symbols, the
   * names of the inputs and the outputs, the palette. Never an expression.
   */
  toStudent(config) {
    return {
      prompt: config.prompt,
      symbols: config.symbols,
      inputs: [...config.inputs],
      outputs: config.outputs.map((o) => o.name),
      palette: { kinds: [...config.palette.kinds], maxGates: config.palette.maxGates },
    };
  },

  /** The key: each output's expression. */
  toSolution(config) {
    return { outputs: config.outputs.map(({ name, expression }) => ({ name, expression })) };
  },

  studentDetails: (details, policy) => logicStudentDetails(details, policy),

  /** One cell of the live dashboard: the size of the drawing, never its worth. */
  summarizeAnswer(_config, answer) {
    const gates = answer.schematic.components.filter((c) => isGateKind(c.kind)).length;
    return `${gates} gates · ${answer.schematic.wires.length} wires`;
  },

  grade: gradeLogic,

  /** Indexed: what a teacher would type to find the question again. */
  searchText(config) {
    return [config.prompt, "logic", ...config.inputs, ...config.outputs.map((o) => o.name)].join(" ");
  },
};
