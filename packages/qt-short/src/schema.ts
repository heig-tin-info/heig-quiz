/**
 * The `short` schemas (docs/04 §4.5, PLAN-MVP §2.2).
 *
 * The matcher semantics themselves live in `@quiz/domain/short` — this module
 * only describes what may be stored, including the two guards of decision D10
 * (a pattern is at most 300 characters and its flags are restricted to `imsu`)
 * and the compilation check that turns an unusable regex into a publication
 * error rather than a grading-time surprise.
 *
 * Version 2 moved the two text options a teacher used to set matcher by
 * matcher (`caseSensitive`, `trim`, `collapseSpaces`) up to the QUESTION, as
 * `prefilters`, and gave the question the `constraints` of its kind. One
 * answer field cannot be case-sensitive for one accepted answer and not for
 * the next, and a teacher who read "Case sensitive" three times on three rows
 * was reading the same decision three times.
 */
import { ALLOWED_REGEX_FLAGS, isValidPattern, MAX_PATTERN_LENGTH } from "@quiz/domain/short";
import { z } from "zod";

export const SHORT_CONFIG_VERSION = 2;

export const SHORT_MAX_MATCHERS = 20;
/** Decision D10: the answer a student may type, and therefore what a regex sees. */
export const SHORT_MAX_ANSWER_LENGTH = 500;
/** What a fresh text question allows: long enough for a sentence, short of the cap. */
export const SHORT_DEFAULT_MAX_LENGTH = 255;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A matcher may be worth a fraction of the item: "almost right" is a real verdict. */
const points = z.number().min(0).max(1).default(1);

export const ShortMatcherSchema = z.discriminatedUnion("kind", [
  /**
   * v2: no text option of its own. The question's `prefilters` are applied to
   * the student's answer AND to this `value` before the comparison.
   */
  z.object({
    kind: z.literal("exact"),
    value: z.string().min(1).max(500),
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
    value: z.string().regex(ISO_DATE),
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

/**
 * What the ANSWER FIELD accepts, per kind. It is not part of the key — a
 * student is told "between 1 and 100", never which number — so `toStudent`
 * carries it whole and the player enforces it in the input.
 *
 * One flat shape rather than four: a teacher who switches the kind back and
 * forth keeps what they typed, and the schema stays one object to validate.
 * Only the fields of the current kind are ever read.
 */
export const ShortConstraintsSchema = z.object({
  /** `text` */
  minLength: z.number().int().min(0).max(SHORT_MAX_ANSWER_LENGTH).default(0),
  maxLength: z.number().int().min(1).max(SHORT_MAX_ANSWER_LENGTH).default(SHORT_DEFAULT_MAX_LENGTH),
  /** `number`; absent means unbounded. */
  min: z.number().optional(),
  max: z.number().optional(),
  integer: z.boolean().default(false),
  /** `date`; absent means unbounded. */
  from: z.string().regex(ISO_DATE).optional(),
  to: z.string().regex(ISO_DATE).optional(),
});
export type ShortConstraints = z.infer<typeof ShortConstraintsSchema>;

export function defaultShortConstraints(): ShortConstraints {
  return { minLength: 0, maxLength: SHORT_DEFAULT_MAX_LENGTH, integer: false };
}

/**
 * The two normalisations applied to the student's answer AND to every text or
 * regex expectation before matching. They replace the per-matcher flags of v1.
 */
export const ShortPrefiltersSchema = z.object({
  trim: z.boolean().default(true),
  lowercase: z.boolean().default(true),
});
export type ShortPrefilters = z.infer<typeof ShortPrefiltersSchema>;

export function defaultShortPrefilters(): ShortPrefilters {
  return { trim: true, lowercase: true };
}

export const ShortConfigSchema = z
  .object({
    configVersion: z.literal(SHORT_CONFIG_VERSION),
    prompt: z.string().min(1).max(20_000),
    /** Drives the input type of the player and which constraints are read. */
    kind: ShortKindSchema.default("text"),
    constraints: ShortConstraintsSchema.default(defaultShortConstraints),
    prefilters: ShortPrefiltersSchema.default(defaultShortPrefilters),
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
      // A field that only takes whole numbers cannot expect 3.5.
      if (config.constraints.integer && matcher.kind === "number" && !Number.isInteger(matcher.value)) {
        ctx.addIssue({
          code: "custom",
          path: ["matchers", index, "value"],
          message: "short.integer_expected",
        });
      }
    });

    const c = config.constraints;
    if (c.minLength > c.maxLength) {
      ctx.addIssue({ code: "custom", path: ["constraints", "maxLength"], message: "short.length_range" });
    }
    if (c.min !== undefined && c.max !== undefined && c.min > c.max) {
      ctx.addIssue({ code: "custom", path: ["constraints", "max"], message: "short.number_range" });
    }
    if (c.from !== undefined && c.to !== undefined && c.from > c.to) {
      ctx.addIssue({ code: "custom", path: ["constraints", "to"], message: "short.date_range" });
    }
  });
export type ShortConfig = z.infer<typeof ShortConfigSchema>;

export const ShortAnswerSchema = z.object({ text: z.string().max(SHORT_MAX_ANSWER_LENGTH) });
export type ShortAnswer = z.infer<typeof ShortAnswerSchema>;

/**
 * Everything a student may see: the matchers are dropped WHOLE. The
 * constraints stay — they are what the field allows, not what it expects.
 */
export const ShortStudentSchema = z.object({
  prompt: z.string(),
  kind: ShortKindSchema,
  constraints: ShortConstraintsSchema,
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
    constraints: defaultShortConstraints(),
    prefilters: defaultShortPrefilters(),
    matchers: [{ kind: "exact", value: "", points: 1 }],
  };
}
