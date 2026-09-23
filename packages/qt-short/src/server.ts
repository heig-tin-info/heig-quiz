/**
 * `@quiz/qt-short/server` — the server half of the `short` type (PLAN-MVP §2.2).
 *
 * No React in this import graph: the API and the grading worker load it.
 */
import { ConfigMigrationError, type QuestionTypeServer } from "@quiz/core/server";
import { describeMatcher } from "@quiz/domain/short";
import { fromCanonical, toCanonical } from "./canonical.js";
import { gradeShort } from "./grade.js";
import {
  defaultShortConstraints,
  defaultShortPrefilters,
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

/** The v1 shape, as it was stored: the text options lived on every matcher. */
interface ShortConfigV1 {
  prompt?: unknown;
  kind?: unknown;
  placeholder?: unknown;
  matchers?: unknown;
}

interface ExactV1 {
  kind: "exact";
  value?: unknown;
  caseSensitive?: unknown;
  trim?: unknown;
  collapseSpaces?: unknown;
  points?: unknown;
}

const isExactV1 = (m: unknown): m is ExactV1 =>
  typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "exact";

/**
 * v1 -> v2 (decision D16: the result is handed to `loadConfig`, which parses;
 * a draft that was invalid in v1 stays invalid in v2, it does not throw here).
 *
 * The two question-level prefilters are read off the FIRST exact matcher,
 * which is the only one a teacher ever configured in practice — the editor
 * showed the same "Case sensitive" box on every row and they all carried the
 * same answer. `collapseSpaces` has no v2 home: collapsing runs of whitespace
 * became unconditional, which is what its `true` default already meant.
 */
export function migrateShortV1(raw: unknown): ShortConfig {
  const v1 = (typeof raw === "object" && raw !== null ? raw : {}) as ShortConfigV1;
  const matchers = Array.isArray(v1.matchers) ? (v1.matchers as unknown[]) : [];
  const firstExact = matchers.find(isExactV1);

  const next: Record<string, unknown> = {
    ...(v1 as Record<string, unknown>),
    configVersion: SHORT_CONFIG_VERSION,
    constraints: defaultShortConstraints(),
    prefilters: {
      trim: typeof firstExact?.trim === "boolean" ? firstExact.trim : true,
      lowercase: typeof firstExact?.caseSensitive === "boolean" ? !firstExact.caseSensitive : true,
    },
    matchers: matchers.map((matcher) => {
      if (!isExactV1(matcher)) return matcher;
      const { caseSensitive: _c, trim: _t, collapseSpaces: _s, ...rest } = matcher;
      return rest;
    }),
  };
  return next as unknown as ShortConfig;
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

  /** Same version: identity, even for an invalid draft (D16). v1: see above. */
  migrate(config: unknown, fromVersion: number): ShortConfig {
    if (fromVersion === SHORT_CONFIG_VERSION) return config as ShortConfig;
    if (fromVersion === 1) return migrateShortV1(config);
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
    const student: ShortStudent = {
      prompt: config.prompt,
      kind: config.kind,
      // What the FIELD accepts, never what it expects: a length, a range or a
      // window of dates says nothing about the answer, and the player needs
      // them to enforce the same thing the teacher typed.
      constraints: { ...config.constraints },
    };
    if (config.placeholder !== undefined) student.placeholder = config.placeholder;
    return student;
  },

  toSolution: (config) => ({ expected: expectedAnswers(config) }),

  /**
   * `matchedIndex` and `matchedKind` describe WHICH matcher accepted the
   * answer — the rank of an alternative in the key and its nature (`regex`,
   * `numeric`, …). Both go when the key is not published; the normalised
   * text (the student's own) and the fraction stay, which is what the review
   * needs to show the verdict.
   */
  studentDetails(details: ShortDetails, policy): unknown {
    if (policy.showKey) return details;
    const { matchedIndex: _index, matchedKind: _kind, ...rest } = details;
    return rest;
  },

  grade: (config, answer, ctx) => gradeShort(config, answer, ctx.itemPoints),

  /**
   * The live grid (F-DASH-02): what the student typed, whitespace collapsed.
   *
   * A short answer IS one line, so there is nothing to summarise — only to
   * keep on one line. The caller truncates; a newline pasted into the field
   * would otherwise break the row.
   */
  summarizeAnswer: (_config, answer) => answer.text.replace(/\s+/g, " ").trim(),

  /**
   * The search index is teacher-facing (`question_versions.search`), so the
   * expected answers belong in it: a teacher looks for "stdio.h", not for the
   * sentence around it.
   */
  searchText: (config) => [config.prompt, ...expectedAnswers(config)].join("\n"),

  toCanonical,
  fromCanonical,
};
