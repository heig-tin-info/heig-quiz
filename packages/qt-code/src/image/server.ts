/**
 * The server half of the `codeimage` question type (docs/spec/04 §4.9,
 * ADR-021), exported by `@quiz/qt-code/server` beside `codeServer`.
 *
 * It is a variant of `code`, not a package of its own: the program half —
 * template, locked regions, reference solution, runtime, limits — is
 * `code`'s, and what differs is small enough to live in `src/image/`. No
 * React in this module graph.
 */
import type { FinalizeContext, GradeContext, QuestionTypeServer } from "@quiz/core/server";
import { ConfigMigrationError, tallyKeys, type RunnerOutcome } from "@quiz/core/server";
import { splitTemplate } from "@quiz/domain/lockedTemplate";

import { fromCanonicalImage, toCanonicalImage } from "./canonical.js";
import { finalizeRunnerCodeImage, gradeCodeImage, interactiveImageRequest } from "./grade.js";
import {
  CODEIMAGE_CONFIG_VERSION,
  CodeImageAnswer,
  CodeImageConfig,
  CodeImageDetails,
  CodeImageSolution,
  CodeImageStudent,
  emptyCodeImageConfig,
} from "./schema.js";

/**
 * The bucket a pixel accuracy falls in, for the class debrief. Language-free
 * on purpose: the keys are what the teacher reads, and a percentage needs no
 * translation.
 */
export function accuracyBucket(correct: number, pixelCount: number): string {
  if (pixelCount <= 0) return "0 %";
  const pct = (100 * correct) / pixelCount;
  if (pct >= 100) return "100 %";
  if (pct >= 90) return "90–99 %";
  if (pct >= 50) return "50–89 %";
  if (pct > 0) return "1–49 %";
  return "0 %";
}

export const codeimageServer: QuestionTypeServer<
  CodeImageConfig,
  CodeImageAnswer,
  CodeImageStudent,
  CodeImageSolution,
  CodeImageDetails
> = {
  id: "codeimage",
  configVersion: CODEIMAGE_CONFIG_VERSION,

  configSchema: CodeImageConfig,
  answerSchema: CodeImageAnswer,
  studentSchema: CodeImageStudent,
  solutionSchema: CodeImageSolution,
  detailsSchema: CodeImageDetails,

  emptyDraft: emptyCodeImageConfig,

  /** `code`'s rule: identity at the current version, a parse for an older one. */
  migrate(config: unknown, fromVersion: number): CodeImageConfig {
    if (fromVersion > CODEIMAGE_CONFIG_VERSION) {
      throw new ConfigMigrationError(
        "codeimage",
        fromVersion,
        CODEIMAGE_CONFIG_VERSION,
        "config written by a newer version of the platform",
      );
    }
    if (fromVersion === CODEIMAGE_CONFIG_VERSION) return config as CodeImageConfig;
    const source = typeof config === "object" && config !== null ? config : {};
    const parsed = CodeImageConfig.safeParse({ ...source, configVersion: CODEIMAGE_CONFIG_VERSION });
    if (!parsed.success) {
      throw new ConfigMigrationError(
        "codeimage",
        fromVersion,
        CODEIMAGE_CONFIG_VERSION,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }
    return parsed.data;
  },

  /** One picture, one point: the score is a fraction of it. */
  defaultPoints() {
    return 1;
  },

  shuffleable() {
    return false;
  },

  /**
   * The one exit toward a student (invariant 4). The TARGET travels — it is
   * the picture to draw, published like a visible case — and so do the
   * image's dimensions and palette. The reference solution, `compileArgs`
   * and the extra files' bytes do not.
   */
  toStudent(config) {
    return {
      prompt: config.prompt,
      language: config.language,
      runtime: config.runtime,
      segments: splitTemplate(config.template, config.language),
      limits: { ...config.limits },
      runsPerMinute: config.runsPerMinute,
      filesPreview: config.files.map((f) => ({ name: f.name, bytes: f.content.length })),
      image: { ...config.image },
      target: config.target,
    };
  },

  toSolution(config) {
    return {
      referenceSolution: config.referenceSolution,
      image: { ...config.image },
      target: config.target,
    };
  },

  /**
   * Nothing to redact: the breakdown holds the student's own picture, the
   * compiler's words about their own code and a count. The target is public
   * and the reference solution never enters it.
   */
  studentDetails(details) {
    return details;
  },

  summarizeAnswer(_config, answer) {
    const written = answer.regions.filter((r) => r.trim() !== "").length;
    return written === 0 ? "—" : `${written}/${answer.regions.length}`;
  },

  /** The distribution of pixel accuracy over the class (F-RES-03). */
  aggregate({ details }) {
    const keys: string[] = [];
    for (const row of details) {
      const parsed = CodeImageDetails.safeParse(row);
      if (!parsed.success) continue;
      keys.push(accuracyBucket(parsed.data.matching, parsed.data.pixelCount));
    }
    return { distribution: tallyKeys(keys) };
  },

  grade(config: CodeImageConfig, answer: CodeImageAnswer | null, ctx: GradeContext) {
    return gradeCodeImage(config, answer, ctx);
  },

  /**
   * The student's Run: one run of the program rebuilt from the STORED
   * template and the regions (invariant 14). The request carries nothing
   * the student could not already see — no case is hidden, and the target
   * is public — so it is exactly the grading request at interactive priority.
   */
  interactiveRequest(config: CodeImageConfig, answer: CodeImageAnswer) {
    return interactiveImageRequest(config, answer);
  },

  finalizeRunner(
    config: CodeImageConfig,
    answer: CodeImageAnswer | null,
    ctx: FinalizeContext,
    outcome: RunnerOutcome,
  ) {
    return finalizeRunnerCodeImage(config, answer, ctx, outcome);
  },

  searchText(config) {
    return [
      config.prompt,
      config.language,
      "codeimage",
      `${config.image.width}x${config.image.height}`,
      config.image.palette,
    ].join(" ");
  },

  toCanonical: toCanonicalImage,
  fromCanonical: fromCanonicalImage,
};
