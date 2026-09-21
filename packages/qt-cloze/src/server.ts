/**
 * `@quiz/qt-cloze/server` — the server half of the `cloze` type (PLAN-MVP §2.3).
 *
 * No React in this import graph: the API and the grading worker load it.
 */
import { ConfigMigrationError, type QuestionTypeServer } from "@quiz/core/server";
import { clozeStudentTemplate, describeBlank } from "@quiz/domain";
import { fromCanonical, toCanonical } from "./canonical.js";
import { gradeClozeAnswer } from "./grade.js";
import { clozeParse } from "./parse.js";
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
  return clozeParse(config).blanks.some((blank) => blank.kind === "select");
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
   * Same version: identity, even for an invalid draft (D16). v1 is v2 with no
   * predefined choice set — nothing in a v1 text can name one, so the list is
   * empty and every blank keeps the kind it already had.
   */
  migrate(config: unknown, fromVersion: number): ClozeConfig {
    if (fromVersion === CLOZE_CONFIG_VERSION) return config as ClozeConfig;
    if (fromVersion === 1) {
      const v1 = (typeof config === "object" && config !== null ? config : {}) as Record<string, unknown>;
      return { ...v1, configVersion: CLOZE_CONFIG_VERSION, choiceSets: [] } as unknown as ClozeConfig;
    }
    throw new ConfigMigrationError(
      "cloze",
      fromVersion,
      CLOZE_CONFIG_VERSION,
      "unknown source version",
    );
  },

  /** One point per blank is the least surprising default for a teacher. */
  defaultPoints: (config) => Math.max(1, clozeParse(config).blanks.length),

  /** Only the dropdowns can be shuffled; a text field has no order. */
  shuffleable: (config) => config.shuffleOptions && hasSelectBlank(config),

  /**
   * THE single exit toward a student (invariant 4). The template carries
   * sentinels instead of blanks, and every `text`, `number` and `regex` blank
   * collapses to an opaque input: no answer, no pattern, no tolerance.
   */
  toStudent(config, view): ClozeStudent {
    return clozeStudentTemplate(
      clozeParse(config),
      view.seed,
      view.itemId,
      view.shuffle && config.shuffleOptions,
    );
  },

  toSolution: (config) => ({
    blanks: clozeParse(config).blanks.map((blank) => ({
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
   * The authoring text, blanks included, plus the labels of the predefined
   * choice sets: a question whose dropdown is written `{{1}}` holds none of
   * its options in the text, and "free" must still find it.
   */
  searchText: (config) =>
    [config.text, ...(config.choiceSets ?? []).flatMap((set) => set.options.map((o) => o.label))]
      .join("\n"),

  toCanonical,
  fromCanonical,
};
