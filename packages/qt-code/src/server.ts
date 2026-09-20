/**
 * `@quiz/qt-code/server` — the server half of the `code` question type.
 *
 * No React, anywhere in this module graph: the API imports it through
 * `@quiz/registry/server`.
 */
import type { FinalizeContext, GradeContext, QuestionTypeServer } from "@quiz/core/server";
import { ConfigMigrationError, type RunnerOutcome } from "@quiz/core/server";
import { splitTemplate } from "@quiz/domain";

import { fromCanonical, toCanonical } from "./canonical.js";
import { finalizeRunnerCode, gradeCode, studentDetails } from "./grade.js";
import {
  CODE_CONFIG_VERSION,
  CodeAnswer,
  CodeConfig,
  CodeDetails,
  CodeSolution,
  CodeStudent,
  emptyCodeConfig,
  totalCasePoints,
} from "./schema.js";

export const codeServer: QuestionTypeServer<
  CodeConfig,
  CodeAnswer,
  CodeStudent,
  CodeSolution,
  CodeDetails
> = {
  id: "code",
  configVersion: CODE_CONFIG_VERSION,

  configSchema: CodeConfig,
  answerSchema: CodeAnswer,
  studentSchema: CodeStudent,
  solutionSchema: CodeSolution,
  detailsSchema: CodeDetails,

  emptyDraft: emptyCodeConfig,

  migrate(config: unknown, fromVersion: number): CodeConfig {
    if (fromVersion > CODE_CONFIG_VERSION) {
      throw new ConfigMigrationError(
        "code",
        fromVersion,
        CODE_CONFIG_VERSION,
        "config written by a newer version of the platform",
      );
    }
    const source = typeof config === "object" && config !== null ? config : {};
    const parsed = CodeConfig.safeParse({ ...source, configVersion: CODE_CONFIG_VERSION });
    if (!parsed.success) {
      throw new ConfigMigrationError(
        "code",
        fromVersion,
        CODE_CONFIG_VERSION,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }
    return parsed.data;
  },

  /** The cases carry the weight of the question; a teacher may still override it. */
  defaultPoints(config) {
    const total = totalCasePoints(config);
    return total > 0 ? total : 1;
  },

  /** Nothing to shuffle: the cases are ordered by the teacher and the template is code. */
  shuffleable() {
    return false;
  },

  toStudent(config) {
    const visible = config.tests.cases.filter((c) => c.visible);
    const hidden = config.tests.cases.filter((c) => !c.visible);
    return {
      prompt: config.prompt,
      language: config.language,
      segments: splitTemplate(config.template, config.language),
      limits: { ...config.limits },
      runsPerMinute: config.runsPerMinute,
      visibleCases: visible.map((c) => ({
        name: c.name,
        stdin: c.stdin,
        expected: c.expected,
        points: c.points,
      })),
      hiddenCount: hidden.length,
      hiddenPoints: hidden.reduce((sum, c) => sum + c.points, 0),
      // Name and size only: a data file may spell the answer out.
      filesPreview: config.files.map((f) => ({ name: f.name, bytes: f.content.length })),
      allOrNothing: config.allOrNothing,
    };
  },

  toSolution(config) {
    return {
      referenceSolution: config.referenceSolution,
      cases: config.tests.cases.map((c) => ({
        name: c.name,
        stdin: c.stdin,
        expected: c.expected,
        points: c.points,
        visible: c.visible,
      })),
      compare: { ...config.tests.compare },
    };
  },

  /**
   * Decision D15: a hidden case keeps its verdict and its points, and loses
   * its name, its expected output and everything the code printed — unless
   * the policy opens the names. A VISIBLE case travels whole: its expected
   * output is published to the student by `toStudent` already (deviation
   * W3-4). `showKey` means the teacher publishes the key, so nothing is cut.
   */
  studentDetails(details: CodeDetails, policy): unknown {
    if (policy.showKey) return details;
    return studentDetails(details, { showHiddenCaseNames: policy.showHiddenCaseNames });
  },

  grade(config: CodeConfig, answer: CodeAnswer | null, ctx: GradeContext) {
    return gradeCode(config, answer, ctx);
  },

  finalizeRunner(
    config: CodeConfig,
    answer: CodeAnswer | null,
    ctx: FinalizeContext,
    outcome: RunnerOutcome,
  ) {
    return finalizeRunnerCode(config, answer, ctx, outcome);
  },

  /** Indexed: what a teacher would type to find the question again. */
  searchText(config) {
    return [config.prompt, config.language, ...config.tests.cases.map((c) => c.name)].join(" ");
  },

  toCanonical,
  fromCanonical,
};

export * from "./grade.js";
export * from "./schema.js";
export { fromCanonical, toCanonical } from "./canonical.js";
