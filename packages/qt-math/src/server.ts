/**
 * `@quiz/qt-math/server` — the server half of the `math` type (docs/spec/04
 * §4.16, ADR-102). No React in this import graph.
 */
import { ConfigMigrationError, tallyKeys, type PublicationIssue, type QuestionTypeServer } from "@quiz/core/server";
import { curveOf } from "@quiz/domain/math";

import { gradeMath, gradingPoints, readKeys } from "./grade.js";
import {
  emptyMathDraft,
  fieldRules,
  isMathAnswered,
  MATH_CONFIG_VERSION,
  MATH_PLOT_POINTS,
  MathAnswerSchema,
  MathConfigSchema,
  MathDetailsSchema,
  MathSolutionSchema,
  MathStudentSchema,
  type MathAnswer,
  type MathConfig,
  type MathDetails,
  type MathSolution,
  type MathStudent,
} from "./schema.js";

/**
 * What the schema cannot say: whether each key READS against the symbols
 * (`math.key_<problem>`), and whether the first one has a value somewhere
 * on the domain — a key undefined everywhere would make every answer
 * wrong (`math.key_undefined`).
 */
export function mathPublicationIssues(config: MathConfig): PublicationIssue[] {
  const keys = readKeys(config);
  const issues = keys.flatMap((key): PublicationIssue[] =>
    key.read.ok ? [] : [{ path: ["answers", key.index, "value"], message: `math.key_${key.read.problem.code}` }],
  );
  const first = keys[0]?.read;
  if (first?.ok && !gradingPoints(config).some((point) => first.reading.evaluate(point) !== null)) {
    issues.push({ path: ["answers", 0, "value"], message: "math.key_undefined" });
  }
  return issues;
}

export const mathServer: QuestionTypeServer<MathConfig, MathAnswer, MathStudent, MathSolution, MathDetails> = {
  id: "math",
  configVersion: MATH_CONFIG_VERSION,

  configSchema: MathConfigSchema,
  answerSchema: MathAnswerSchema,
  isAnswered: isMathAnswered,
  studentSchema: MathStudentSchema,
  solutionSchema: MathSolutionSchema,
  detailsSchema: MathDetailsSchema,

  emptyDraft: emptyMathDraft,

  migrate(config: unknown, fromVersion: number): MathConfig {
    if (fromVersion === MATH_CONFIG_VERSION) return config as MathConfig;
    throw new ConfigMigrationError("math", fromVersion, MATH_CONFIG_VERSION, "unknown source version");
  },

  defaultPoints: () => 1,

  /** Nothing to shuffle: one prompt, one field. */
  shuffleable: () => false,

  /**
   * THE single exit toward a student (invariant 4): the keys, the sample
   * intervals, the tolerance and the sample count go. The field's rules
   * stay, as one object (`fieldRules`) — a student is told what they may
   * write, and the grader reads the answer with exactly that. With a plot,
   * the window of the one symbol; with the target, the first key's curve
   * as values over that window (§4.16: a deliberate numeric exit of the key).
   */
  toStudent(config): MathStudent {
    const student: MathStudent = { prompt: config.prompt, plot: config.plot, ...fieldRules(config) };
    const symbol = config.symbols[0];
    if (config.plot === "none" || symbol === undefined) return student;
    student.axis = { from: symbol.min, to: symbol.max };
    const key = readKeys(config)[0]?.read;
    if (config.plot === "target" && key?.ok) student.target = curveOf(key.reading, symbol.name, symbol.min, symbol.max, MATH_PLOT_POINTS);
    return student;
  },

  toSolution: (config) => ({ answers: config.answers.map(({ value, points }) => ({ value, points })) }),

  publicationIssues: mathPublicationIssues,

  hasKey: () => true,

  /** Which key matched goes with the key; the verdict, the reason and the echo stay. */
  studentDetails(details: MathDetails, policy): unknown {
    if (policy.showKey) return details;
    const { matchedIndex: _index, ...rest } = details;
    return rest;
  },

  grade: (config, answer, ctx) => gradeMath(config, answer, ctx.itemPoints),

  /** The live grid (F-DASH-02): the LaTeX as typed, on one line. */
  summarizeAnswer: (_config, answer) => answer.latex.replace(/\s+/g, " ").trim(),

  /** By the text typed, trimmed: the debrief groups what was written, as `short` does. */
  aggregate({ answers }) {
    const keys: string[] = [];
    for (const payload of answers) {
      if (payload && typeof payload === "object" && "latex" in payload) {
        keys.push(String((payload as { latex: unknown }).latex ?? "").trim());
      }
    }
    return { distribution: tallyKeys(keys) };
  },

  searchText: (config) => [config.prompt, ...config.answers.map((a) => a.value)].join("\n"),
};
