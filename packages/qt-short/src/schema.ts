/**
 * The `short` schemas (docs/04 §4.5, PLAN-MVP §2.2).
 *
 * The matcher semantics themselves live in `@quiz/domain/short` — this module
 * only describes what may be stored, including the two guards of decision D10
 * (a pattern is at most 300 characters and its flags are restricted to `imsu`)
 * and the compilation check that turns an unusable regex into a publication
 * error rather than a grading-time surprise.
 */
import { ALLOWED_REGEX_FLAGS, isValidPattern, MAX_PATTERN_LENGTH } from "@quiz/domain";
import { z } from "zod";

export const SHORT_CONFIG_VERSION = 1;

export const SHORT_MAX_MATCHERS = 20;
/** Decision D10: the answer a student may type, and therefore what a regex sees. */
export const SHORT_MAX_ANSWER_LENGTH = 500;

/** A matcher may be worth a fraction of the item: "almost right" is a real verdict. */
const points = z.number().min(0).max(1).default(1);

export const ShortMatcherSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exact"),
    value: z.string().min(1).max(500),
    caseSensitive: z.boolean().default(false),
    trim: z.boolean().default(true),
    collapseSpaces: z.boolean().default(true),
    points,
  }),
  z.object({
    kind: z.literal("regex"),
    pattern: z.string().min(1).max(MAX_PATTERN_LENGTH),
    flags: z.string().regex(ALLOWED_REGEX_FLAGS).default("i"),
    points,
  }),
  z.object({
    kind: z.literal("number"),
    value: z.number(),
    tolerance: z.number().min(0).default(0),
    toleranceMode: z.enum(["abs", "rel"]).default("abs"),
    unit: z.string().max(16).optional(),
    unitRequired: z.boolean().default(false),
    points,
  }),
  z.object({
    kind: z.literal("date"),
    value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    toleranceDays: z.number().int().min(0).default(0),
    points,
  }),
  z.object({
    kind: z.literal("time"),
    value: z.string().regex(/^\d{2}:\d{2}$/),
    toleranceMinutes: z.number().int().min(0).default(0),
    points,
  }),
  /**
   * Phase 2. The shape is accepted so that an imported question survives a
   * round trip, but `hasLlmMatcher` (`@quiz/domain/short`) refuses it at
   * publication with `llm_not_available`, and `matchShort` never matches it.
   */
  z.object({
    kind: z.literal("llm"),
    rubric: z.string().min(1).max(4000),
    reference: z.string().max(4000).optional(),
    points,
  }),
]);
export type ShortMatcher = z.infer<typeof ShortMatcherSchema>;

export const ShortKindSchema = z.enum(["text", "number", "date", "time"]);
export type ShortKind = z.infer<typeof ShortKindSchema>;

export const ShortConfigSchema = z
  .object({
    configVersion: z.literal(SHORT_CONFIG_VERSION),
    prompt: z.string().min(1).max(20_000),
    /** Drives the input type of the player; the matchers stay free of it. */
    kind: ShortKindSchema.default("text"),
    placeholder: z.string().max(80).optional(),
    matchers: z.array(ShortMatcherSchema).min(1).max(SHORT_MAX_MATCHERS),
  })
  .superRefine((config, ctx) => {
    config.matchers.forEach((matcher, index) => {
      if (matcher.kind === "regex" && !isValidPattern(matcher.pattern, matcher.flags)) {
        ctx.addIssue({
          code: "custom",
          path: ["matchers", index, "pattern"],
          message: "short.invalid_pattern",
        });
      }
    });
  });
export type ShortConfig = z.infer<typeof ShortConfigSchema>;

export const ShortAnswerSchema = z.object({ text: z.string().max(SHORT_MAX_ANSWER_LENGTH) });
export type ShortAnswer = z.infer<typeof ShortAnswerSchema>;

/** Everything a student may see: the matchers are dropped WHOLE. */
export const ShortStudentSchema = z.object({
  prompt: z.string(),
  kind: ShortKindSchema,
  placeholder: z.string().optional(),
});
export type ShortStudent = z.infer<typeof ShortStudentSchema>;

/** Human rendering of the key, e.g. `["0x1004", "≈ 3.14 ± 1 %"]`. */
export const ShortSolutionSchema = z.object({ expected: z.array(z.string()) });
export type ShortSolution = z.infer<typeof ShortSolutionSchema>;

export const ShortDetailsSchema = z.object({
  matchedIndex: z.number().int().nullable(),
  matchedKind: z.string().nullable(),
  normalized: z.string(),
  fraction: z.number(),
});
export type ShortDetails = z.infer<typeof ShortDetailsSchema>;

/** See `emptyMcqDraft`: the shape and the defaults, no content, may be invalid. */
export function emptyShortDraft(): ShortConfig {
  return {
    configVersion: SHORT_CONFIG_VERSION,
    prompt: "",
    kind: "text",
    matchers: [
      { kind: "exact", value: "", caseSensitive: false, trim: true, collapseSpaces: true, points: 1 },
    ],
  };
}
