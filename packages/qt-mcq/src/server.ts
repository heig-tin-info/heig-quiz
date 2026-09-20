/**
 * `@quiz/qt-mcq/server` — the server half of the `mcq` type (PLAN-MVP §2.1).
 *
 * NOTHING in this module's import graph may reach React: it is loaded by the
 * API and by the grading worker. The browser half is `./client`.
 */
import { ConfigMigrationError, type QuestionTypeServer, type StudentView } from "@quiz/core/server";
import { seededShuffle, streamSeed } from "@quiz/core/rng";
import { gradeMcq } from "./grade.js";
import { fromCanonical, toCanonical } from "./canonical.js";
import {
  correctIndices,
  emptyMcqDraft,
  MCQ_CONFIG_VERSION,
  McqAnswerSchema,
  McqConfigSchema,
  McqDetailsSchema,
  McqSolutionSchema,
  McqStudentSchema,
  type McqAnswer,
  type McqConfig,
  type McqDetails,
  type McqSolution,
  type McqStudent,
} from "./schema.js";

/**
 * The display order of the choices, as canonical indices.
 *
 * A permutation is never stored: it is recomputed from
 * `(attempt.seed, item.id, "choices")`, so a reload, the teacher preview and a
 * regrade all show the same order (decision D19).
 */
export function choiceOrder(config: McqConfig, view: StudentView): number[] {
  const canonical = config.choices.map((_, index) => index);
  if (!(view.shuffle && config.shuffleChoices)) return canonical;
  return seededShuffle(canonical, streamSeed(view.seed, view.itemId, "choices"));
}

export const mcqServer: QuestionTypeServer<
  McqConfig,
  McqAnswer,
  McqStudent,
  McqSolution,
  McqDetails
> = {
  id: "mcq",
  configVersion: MCQ_CONFIG_VERSION,

  configSchema: McqConfigSchema,
  answerSchema: McqAnswerSchema,
  studentSchema: McqStudentSchema,
  solutionSchema: McqSolutionSchema,
  detailsSchema: McqDetailsSchema,

  emptyDraft: emptyMcqDraft,

  /**
   * v1 is the only shape that ever existed, so raising a v1 config is the
   * identity. Validation is NOT done here: `loadConfig` (PLAN-MVP §1.6) parses
   * right after, and a migration that threw on an invalid row would hide the
   * real error behind a migration failure.
   */
  migrate(config: unknown, fromVersion: number): McqConfig {
    if (fromVersion === MCQ_CONFIG_VERSION) return config as McqConfig;
    throw new ConfigMigrationError("mcq", fromVersion, MCQ_CONFIG_VERSION, "unknown source version");
  },

  defaultPoints: () => 1,

  shuffleable: (config) => config.shuffleChoices && config.choices.length > 1,

  /**
   * THE single exit toward a student (invariant 4). It keeps the prompt, the
   * choice texts, the mode and `maxSelections`, and drops `correct`, `policy`,
   * `penalty` and `allowNegative` — knowing the policy would tell a student
   * whether guessing costs anything.
   */
  toStudent(config, view): McqStudent {
    const order = choiceOrder(config, view);
    const student: McqStudent = {
      prompt: config.prompt,
      choices: order.map((id) => ({ id, text: config.choices[id]?.text ?? "" })),
      mode: config.mode,
    };
    if (config.maxSelections !== undefined) student.maxSelections = config.maxSelections;
    return student;
  },

  toSolution: (config) => ({ correct: correctIndices(config) }),

  grade: (config, answer, ctx) => gradeMcq(config, answer, ctx.itemPoints),

  searchText: (config) => [config.prompt, ...config.choices.map((c) => c.text)].join("\n"),

  toCanonical,
  fromCanonical,
};
