/**
 * The server half of the `logic` question type (docs/spec/04 §4.18,
 * ADR-123), the second type of this package (ADR-021 §1). No React: the API
 * reaches it through `@quiz/qt-circuit/server`.
 */
import type { QuestionTypeServer } from "@quiz/core/server";
import { reparseMigrate } from "@quiz/core/server";

import {
  logicAnswerDoc,
  logicAnswerZone,
  logicSolutionDoc,
  logicStatementDoc,
  logicStudentAnswerDoc,
} from "./logicDocument.js";
import { gradeLogic, logicStudentDetails } from "./logicGrade.js";
import { logicSummary } from "./logicLibrary.js";
import {
  emptyLogicConfig,
  isLogicAnswered,
  LOGIC_CONFIG_VERSION,
  LogicAnswer,
  LogicConfig,
  LogicDetails,
  LogicSolution,
  LogicStudent,
  referenceUndefinedRow,
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
   * names of the inputs and the outputs, the palette. Never an expression,
   * a vector nor the reference circuit. The mode is not sent either, since no surface needs it,
   * though the palette (flip-flops or not) and the prompt usually tell it.
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

  /**
   * What publication needs beyond the schema: a combinational reference that
   * reads a level on every row. Up to 1 024 simulations, so here (publication
   * and the draft's issues) and never in the schema, which every read runs.
   */
  publicationIssues(config) {
    if (config.mode === "sequential" || config.keyFrom !== "reference" || config.reference === null) return [];
    const row = referenceUndefinedRow({ ...config, reference: config.reference });
    return row === null ? [] : [{ path: ["reference"], message: "logic.reference_undefined" }];
  },

  /**
   * The key: each output's expression, the test vectors, or the reference
   * circuit when it is the key. Never `toStudent`: a student reads it only
   * where the key may be shown.
   */
  toSolution(config) {
    if (config.mode === "sequential") return { outputs: [], vectors: config.vectors };
    if (config.keyFrom === "reference" && config.reference !== null) return { outputs: [], reference: config.reference };
    return { outputs: config.outputs.map(({ name, expression }) => ({ name, expression })) };
  },

  studentDetails: (details, policy) => logicStudentDetails(details, policy),

  /** One cell of the live dashboard: the gate budget, never the circuit's worth (`logicSummary`). */
  summarizeAnswer(config, answer) {
    return logicSummary(answer.schematic, config.palette.maxGates);
  },

  grade: gradeLogic,

  /** Indexed: what a teacher would type to find the question again. */
  searchText(config) {
    return [config.prompt, "logic", ...config.inputs, ...config.outputs.map((o) => o.name)].join(" ");
  },

  /* On paper (ADR-126): a squared frame under the declared terminals, the key as equations, vectors or the reference drawn. */
  statementDoc: logicStatementDoc,
  solutionDoc: logicSolutionDoc,
  answerZone: logicAnswerZone,
  studentAnswerDoc: logicStudentAnswerDoc,
  answerDoc: logicAnswerDoc,
};
