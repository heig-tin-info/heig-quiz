/**
 * `@quiz/qt-brainstorm/server` — the server half of the `brainstorm` type
 * (issue #458, ADR-071). No React in this import graph.
 */
import { ConfigMigrationError, tallyKeys, type QuestionTypeServer } from "@quiz/core/server";
import { ideaKey, ideasOf } from "@quiz/domain";

import {
  BRAINSTORM_CONFIG_VERSION,
  BrainstormAnswerSchema,
  BrainstormConfigSchema,
  BrainstormDetailsSchema,
  BrainstormSolutionSchema,
  BrainstormStudentSchema,
  emptyBrainstormDraft,
  isBrainstormAnswered,
  type BrainstormAnswer,
  type BrainstormConfig,
  type BrainstormDetails,
  type BrainstormSolution,
  type BrainstormStudent,
} from "./schema.js";

export const brainstormServer: QuestionTypeServer<
  BrainstormConfig,
  BrainstormAnswer,
  BrainstormStudent,
  BrainstormSolution,
  BrainstormDetails
> = {
  id: "brainstorm",
  configVersion: BRAINSTORM_CONFIG_VERSION,
  configSchema: BrainstormConfigSchema,
  // There is no key to make optional: the poll launcher's gate is the same.
  keylessConfigSchema: BrainstormConfigSchema,
  answerSchema: BrainstormAnswerSchema,
  studentSchema: BrainstormStudentSchema,
  solutionSchema: BrainstormSolutionSchema,
  detailsSchema: BrainstormDetailsSchema,

  emptyDraft: emptyBrainstormDraft,

  migrate(config: unknown, fromVersion: number): BrainstormConfig {
    if (fromVersion === BRAINSTORM_CONFIG_VERSION) return config as BrainstormConfig;
    throw new ConfigMigrationError("brainstorm", fromVersion, BRAINSTORM_CONFIG_VERSION, "unknown source version");
  },

  /** A poll item is never graded; the item still needs a scale. */
  defaultPoints: () => 1,
  shuffleable: () => false,

  toStudent: (config) => ({ prompt: config.prompt, maxIdeas: config.maxIdeas }),
  toSolution: () => null,

  /** Never: a brainstorm is an opinion, so only a poll runs it. */
  hasKey: () => false,

  grade: (_config, _answer, ctx) => ({ kind: "graded", points: 0, maxPoints: ctx.itemPoints, details: {} }),

  isAnswered: isBrainstormAnswered,

  answerMisfit: (config, answer) =>
    answer.ideas.length > config.maxIdeas ? `at most ${config.maxIdeas} ideas` : null,

  summarizeAnswer: (_config, answer) => ideasOf(answer).join(" · "),

  /** By idea, folded the way the cloud folds them. */
  aggregate({ answers }) {
    const keys = answers.flatMap((payload) =>
      [...new Map(ideasOf(payload).map((text) => [ideaKey(text), text])).entries()].map(([key, label]) => ({
        key,
        label,
      })),
    );
    return { distribution: tallyKeys(keys) };
  },

  searchText: (config) => config.prompt,
};
