/**
 * `@quiz/qt-short/server` — the server half of the `short` type (PLAN-MVP §2.2).
 *
 * No React in this import graph: the API and the grading worker load it.
 */
import { ConfigMigrationError, type QuestionTypeServer } from "@quiz/core/server";
import { describeMatcher } from "@quiz/domain";
import { fromCanonical, toCanonical } from "./canonical.js";
import { gradeShort } from "./grade.js";
import {
  emptyShortDraft,
  SHORT_CONFIG_VERSION,
  ShortAnswerSchema,
  ShortConfigSchema,
  ShortDetailsSchema,
  ShortSolutionSchema,
  ShortStudentSchema,
  type ShortAnswer,
  type ShortConfig,
  type ShortDetails,
  type ShortSolution,
  type ShortStudent,
} from "./schema.js";

/** The key as a teacher reads it: one line per matcher, in evaluation order. */
export function expectedAnswers(config: ShortConfig): string[] {
  return config.matchers.map(describeMatcher);
}

export const shortServer: QuestionTypeServer<
  ShortConfig,
  ShortAnswer,
  ShortStudent,
  ShortSolution,
  ShortDetails
> = {
  id: "short",
  configVersion: SHORT_CONFIG_VERSION,

  configSchema: ShortConfigSchema,
  answerSchema: ShortAnswerSchema,
  studentSchema: ShortStudentSchema,
  solutionSchema: ShortSolutionSchema,
  detailsSchema: ShortDetailsSchema,

  emptyDraft: emptyShortDraft,

  /** v1 is the only shape that ever existed; `loadConfig` parses right after. */
  migrate(config: unknown, fromVersion: number): ShortConfig {
    if (fromVersion === SHORT_CONFIG_VERSION) return config as ShortConfig;
    throw new ConfigMigrationError(
      "short",
      fromVersion,
      SHORT_CONFIG_VERSION,
      "unknown source version",
    );
  },

  defaultPoints: () => 1,

  /** Nothing to shuffle: one prompt, one field. */
  shuffleable: () => false,

  /**
   * THE single exit toward a student (invariant 4): the whole `matchers` array
   * is dropped. A student never learns that a blank is graded by a regex, what
   * tolerance a number carries, or how many alternatives are accepted.
   */
  toStudent(config): ShortStudent {
    const student: ShortStudent = { prompt: config.prompt, kind: config.kind };
    if (config.placeholder !== undefined) student.placeholder = config.placeholder;
    return student;
  },

  toSolution: (config) => ({ expected: expectedAnswers(config) }),

  grade: (config, answer, ctx) => gradeShort(config, answer, ctx.itemPoints),

  /**
   * The search index is teacher-facing (`question_versions.search`), so the
   * expected answers belong in it: a teacher looks for "stdio.h", not for the
   * sentence around it.
   */
  searchText: (config) => [config.prompt, ...expectedAnswers(config)].join("\n"),

  toCanonical,
  fromCanonical,
};
