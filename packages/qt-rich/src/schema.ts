/**
 * The `rich` schemas (docs/spec/04 §4.8, issue #192): an essay, written in a
 * formatted field or a plain one, graded by hand against a rubric.
 *
 * The LIMIT is a number of characters, not of words: a schema can count
 * characters, and a "word" is ambiguous as soon as the answer holds code or a
 * formula. It is counted on the STORED text — markdown marks included — so the
 * counter the student reads, the check of the autosave and this file all
 * measure the same string with the same rule ({@link countChars}).
 */
import { z } from "zod";

export const RICH_CONFIG_VERSION = 1;

/**
 * The hard cap of an answer, whatever the question says: about seventeen A4
 * pages. The autosave sends the WHOLE answer every 300 ms, so the cap is what
 * bounds one write, and a question's own `maxChars` may never exceed it.
 */
export const RICH_MAX_CHARS = 50_000;

/**
 * How many characters fill an A4 page, for the hint beside a limit: 11 pt,
 * single spacing, 2.5 cm margins, spaces included. A rule of thumb for the
 * teacher choosing a limit and the student measuring an answer, never a
 * rule of grading.
 */
export const CHARS_PER_A4_PAGE = 3_000;

/**
 * The one measure of an answer's length. UTF-16 code units, which is what
 * `String.length`, zod's `.max()` and a textarea's `maxLength` all count: the
 * player, the schema and the browser agree to the character. An emoji counts
 * two; an essay does not notice.
 */
export const countChars = (text: string): number => text.length;

/** An A4 page count, rounded to a tenth: 1500 characters is 0.5 page. */
export const a4Pages = (chars: number): number => Math.round((chars / CHARS_PER_A4_PAGE) * 10) / 10;

/** "0.4", « 0,4 »: {@link a4Pages} in the reader's decimal separator. */
export const pagesText = (chars: number, decimal: string): string =>
  String(a4Pages(chars)).replace(".", decimal);

export const RichFormatSchema = z.enum(["markdown", "plain"]);
export type RichFormat = z.infer<typeof RichFormatSchema>;

export const RichConfigSchema = z.object({
  configVersion: z.literal(RICH_CONFIG_VERSION),
  prompt: z.string().min(1).max(20_000),
  /**
   * What earns the points, in markdown: the grader reads it beside every
   * answer. It may be empty — a teacher who grades by their own judgement
   * owes the tool no form — but it never reaches a student before the key is
   * released (invariant 4).
   */
  rubric: z.string().max(20_000).default(""),
  /** A model answer, for the grader's eyes only. */
  reference: z.string().max(RICH_MAX_CHARS).optional(),
  /** Absent: no limit but {@link RICH_MAX_CHARS}. */
  maxChars: z.number().int().min(1).max(RICH_MAX_CHARS).optional(),
  /** `markdown` lends the student the formatted editor; `plain` a bare field. */
  format: RichFormatSchema.default("markdown"),
});
export type RichConfig = z.infer<typeof RichConfigSchema>;

/** The whole answer, as typed; the autosave sends it whole every time. */
export const RichAnswerSchema = z.object({ text: z.string().max(RICH_MAX_CHARS) });
export type RichAnswer = z.infer<typeof RichAnswerSchema>;

/** Issue #89: the ONE predicate behind both `isAnswered` hooks. */
export function isRichAnswered(answer: RichAnswer): boolean {
  return answer.text.trim() !== "";
}

/** How much a student may write on this question: its own limit, else the cap. */
export function charLimit(maxChars: number | undefined): number {
  return Math.min(maxChars ?? RICH_MAX_CHARS, RICH_MAX_CHARS);
}

/**
 * What a student may see: the statement, the field's format and its limit —
 * a limit is what the FIELD takes, not what the grader expects. The rubric
 * and the model answer are dropped whole.
 */
export const RichStudentSchema = z.object({
  prompt: z.string(),
  format: RichFormatSchema,
  maxChars: z.number().int().optional(),
});
export type RichStudent = z.infer<typeof RichStudentSchema>;

/**
 * The grader's guide. The teacher's panel gets it whole; a student, once the
 * key is shown, gets the model answer alone — the rubric is the teacher's
 * (`studentSolution`, ADR-037), hence optional here.
 */
export const RichSolutionSchema = z.object({
  rubric: z.string().optional(),
  reference: z.string().optional(),
});
export type RichSolution = z.infer<typeof RichSolutionSchema>;

/**
 * `manual`: a person grades it, the 0 points are a placeholder. `empty`:
 * nothing was written, and the 0 is the grade. `llm`: the essay went to the
 * LLM service, whose points and confidence are the grading's own fields; its
 * justification sits in the details, teacher-only (F-GRADE-02, ADR-045).
 */
export const RichDetailsSchema = z.object({
  reason: z.enum(["manual", "empty", "llm"]),
  chars: z.number().int().min(0),
});
export type RichDetails = z.infer<typeof RichDetailsSchema>;

/** See `emptyMcqDraft`: the shape and the defaults, no content, may be invalid. */
export function emptyRichDraft(): RichConfig {
  return {
    configVersion: RICH_CONFIG_VERSION,
    prompt: "",
    rubric: "",
    format: "markdown",
  };
}
