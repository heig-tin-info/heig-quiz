/**
 * `@quiz/qt-cloze/server` — the server half of the `cloze` type (PLAN-MVP §2.3).
 *
 * No React in this import graph: the API and the grading worker load it.
 */
import { ConfigMigrationError, type QuestionTypeServer } from "@quiz/core/server";
import { clozeStudentTemplate, describeBlank, parseCloze } from "@quiz/domain/cloze";
import { fromCanonical, toCanonical } from "./canonical.js";
import { gradeClozeAnswer } from "./grade.js";
import {
  CLOZE_CONFIG_VERSION,
  ClozeAnswerSchema,
  ClozeConfigSchema,
  ClozeDetailsSchema,
  ClozeSolutionSchema,
  ClozeStudentSchema,
  emptyClozeDraft,
  type ClozeAnswer,
  type ClozeConfig,
  type ClozeDetails,
  type ClozeSolution,
  type ClozeStudent,
} from "./schema.js";

/** Does this text hold at least one dropdown, the only shuffleable thing here? */
export function hasSelectBlank(config: ClozeConfig): boolean {
  return parseCloze(config.text).blanks.some((blank) => blank.kind === "select");
}

export const clozeServer: QuestionTypeServer<
  ClozeConfig,
  ClozeAnswer,
  ClozeStudent,
  ClozeSolution,
  ClozeDetails
> = {
  id: "cloze",
  configVersion: CLOZE_CONFIG_VERSION,

  configSchema: ClozeConfigSchema,
  answerSchema: ClozeAnswerSchema,
  studentSchema: ClozeStudentSchema,
  solutionSchema: ClozeSolutionSchema,
  detailsSchema: ClozeDetailsSchema,

  emptyDraft: emptyClozeDraft,

  /**
   * Same version: identity, even for an invalid draft (D16). v1 → v2 is the
   * identity plus the version stamp — the two shapes are the same (schema.ts
   * says why the number moved anyway).
   */
  migrate(config: unknown, fromVersion: number): ClozeConfig {
    if (fromVersion === CLOZE_CONFIG_VERSION) return config as ClozeConfig;
    if (fromVersion === 1) {
      const v1 = (typeof config === "object" && config !== null ? config : {}) as Record<string, unknown>;
      return { ...v1, configVersion: CLOZE_CONFIG_VERSION } as unknown as ClozeConfig;
    }
    throw new ConfigMigrationError(
      "cloze",
      fromVersion,
      CLOZE_CONFIG_VERSION,
      "unknown source version",
    );
  },

  /** One point per blank is the least surprising default for a teacher. */
  defaultPoints: (config) => Math.max(1, parseCloze(config.text).blanks.length),

  /** Only the dropdowns can be shuffled; a text field has no order. */
  shuffleable: (config) => config.shuffleOptions && hasSelectBlank(config),

  /**
   * THE single exit toward a student (invariant 4). The template carries
   * sentinels instead of blanks, and every `text`, `number` and `regex` blank
   * collapses to an opaque input: no answer, no pattern, no tolerance.
   */
  toStudent(config, view): ClozeStudent {
    return clozeStudentTemplate(
      parseCloze(config.text),
      view.seed,
      view.itemId,
      view.shuffle && config.shuffleOptions,
    );
  },

  toSolution: (config) => ({
    blanks: parseCloze(config.text).blanks.map((blank) => ({
      index: blank.index,
      expected: describeBlank(blank),
    })),
  }),

  /**
   * `perBlank[].expected` is the key, blank by blank. The verdict, the weight
   * and what the student typed stay: they are the feedback. The expected
   * value only travels when the teacher publishes the key.
   */
  studentDetails(details: ClozeDetails, policy): unknown {
    if (policy.showKey) return details;
    return {
      ...details,
      perBlank: details.perBlank.map(({ expected: _expected, ...rest }) => rest),
    };
  },

  grade: (config, answer, ctx) => gradeClozeAnswer(config, answer, ctx.itemPoints),

  /**
   * The live grid (F-DASH-02): the blanks in order, joined by " · ".
   *
   * A dropdown stores the CANONICAL option index as a decimal string
   * (decision D4), which would read as "2 · 0 · 1" in the teacher's column —
   * three numbers that mean nothing. So a `select` blank is resolved back to
   * its label here. An untouched blank is an em dash, because the POSITION of
   * what is missing is half of what the teacher is reading.
   */
  summarizeAnswer(config, answer) {
    const blanks = parseCloze(config.text).blanks;
    return answer.blanks
      .map((value, index) => {
        if (value === null || value.trim() === "") return "—";
        const blank = blanks[index];
        if (blank?.kind === "select") {
          const option = blank.options[Number(value)];
          if (option !== undefined) return option;
        }
        return value.trim();
      })
      .join(" · ");
  },

  /** The authoring text, blanks included: every answer a cloze holds is in it. */
  searchText: (config) => config.text,

  toCanonical,
  fromCanonical,
};
