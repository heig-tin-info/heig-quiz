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
  choiceLetter,
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
  type McqQuestionPolicy,
  type McqSolution,
  type McqStudent,
} from "./schema.js";

/** v1 policies, as they were stored before `MCQ_CONFIG_VERSION` became 2. */
const V1_POLICY: Record<string, McqQuestionPolicy> = {
  all_or_nothing: "all_or_nothing",
  partial: "symmetric",
  penalized: "symmetric",
};

/**
 * One v1 config raised to v2. Total by construction: an unreadable `policy`
 * becomes `all_or_nothing`, and everything else travels untouched — the rest
 * of the shape did not move between the two versions.
 */
function migrateV1(config: unknown): McqConfig {
  const v1 = (config ?? {}) as Record<string, unknown> & { policy?: unknown };
  const { penalty: _penalty, allowNegative: _allowNegative, ...rest } = v1;
  return {
    ...rest,
    policy: V1_POLICY[String(v1.policy)] ?? "all_or_nothing",
    configVersion: MCQ_CONFIG_VERSION,
  } as McqConfig;
}

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
   * v1 → v2: the scoring policies changed (docs/04 §4.4).
   *
   * v1 stored `all_or_nothing | partial | penalized` plus a `penalty` factor
   * and an `allowNegative` floor. v2 stores one of five named policies, or
   * `inherit`, and no numbers at all. `partial` and `penalized` both map onto
   * `symmetric`, the closest of the five: proportional credit minus a
   * proportional penalty, never negative. `all_or_nothing` stays itself, and
   * `penalty` and `allowNegative` are dropped — there is nothing left to put
   * them in.
   *
   * Validation is NOT done here: `loadConfig` (PLAN-MVP §1.6) parses right
   * after, and a migration that threw on an invalid row would hide the real
   * error behind a migration failure. A config already at the current version
   * is returned as it stands, which may well be an invalid draft (D16).
   */
  migrate(config: unknown, fromVersion: number): McqConfig {
    if (fromVersion === MCQ_CONFIG_VERSION) return config as McqConfig;
    if (fromVersion === 1) return migrateV1(config);
    throw new ConfigMigrationError("mcq", fromVersion, MCQ_CONFIG_VERSION, "unknown source version");
  },

  defaultPoints: () => 1,

  shuffleable: (config) => config.shuffleChoices && config.choices.length > 1,

  /**
   * THE single exit toward a student (invariant 4). It keeps the prompt, the
   * choice texts, the mode and `maxSelections`, and drops `correct` and
   * `policy` — knowing the policy would tell a student whether guessing costs
   * anything.
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

  /**
   * `details.correct` is the answer key, and the breakdown is served to the
   * student by the feedback policy: it goes when the key is not published.
   * `c`/`C` and `w`/`W` stay — they are the student's own score, which is
   * what the review shows next to it.
   */
  studentDetails(details: McqDetails, policy): unknown {
    if (policy.showKey) return details;
    const { correct: _correct, ...rest } = details;
    return rest;
  },

  // `ctx.defaults` carries the EVALUATION's per-type settings; `gradeMcq`
  // reads its own `mcq` entry to resolve an `inherit` config.
  grade: (config, answer, ctx) => gradeMcq(config, answer, ctx.itemPoints, ctx.defaults),

  /**
   * The live grid (F-DASH-02): the LETTERS the student ticked, "A, C".
   *
   * The letter is the canonical position, never the shuffled one, so two
   * students who saw the choices in two different orders still read the same
   * way down the teacher's column — the column is the question, not one
   * student's screen. Nothing here says whether the answer is right.
   */
  summarizeAnswer(config, answer) {
    const selected = [...answer.selected]
      .filter((index) => index >= 0 && index < config.choices.length)
      .sort((a, b) => a - b);
    return selected.map(choiceLetter).join(", ");
  },

  searchText: (config) => [config.prompt, ...config.choices.map((c) => c.text)].join("\n"),

  toCanonical,
  fromCanonical,
};
