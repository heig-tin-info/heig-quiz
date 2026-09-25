/**
 * The `cloze` schemas (docs/04 §4.6, PLAN-MVP §2.3).
 *
 * The `{{…}}` grammar itself lives in `@quiz/domain/cloze` — parser, student
 * projection and grader — and is NOT re-implemented here: the editor preview,
 * `toStudent` and the grading all call the same `parseCloze`, so what the
 * teacher sees, what the student plays and what is graded cannot drift.
 */
import { parseCloze } from "@quiz/domain/cloze";
import { z } from "zod";

/**
 * v2 is v1. The version was bumped for the predefined choice sets, which the
 * teacher then asked to have removed before anything shipped, so nothing was
 * ever stored under it that v1 could not hold; the stamp stays because a
 * version number that goes backwards is worse than one that stood still. A
 * stored config still carrying `choiceSets` is simply STRIPPED by the schema
 * below — zod drops unknown keys — and its `{{<key>}}` holes become the
 * ordinary text blanks they are spelled as.
 */
export const CLOZE_CONFIG_VERSION = 2;

/** docs/04: a cloze holds at most fifty blanks, and an answer at most 200 characters. */
export const CLOZE_MAX_BLANKS = 50;
export const CLOZE_MAX_BLANK_LENGTH = 200;

export const ClozeConfigSchema = z
  .object({
    configVersion: z.literal(CLOZE_CONFIG_VERSION),
    /** Markdown with `{{…}}` holes; blanks inside a fenced code block stay active. */
    text: z.string().min(1).max(20_000),
    caseSensitive: z.boolean().default(false),
    shuffleOptions: z.boolean().default(true),
  })
  .superRefine((config, ctx) => {
    /*
     * The SAME parser the grader and `toStudent` call, so a blank the teacher
     * sees here is the blank they get there.
     */
    const parse = parseCloze(config.text);
    for (const error of parse.errors) {
      ctx.addIssue({ code: "custom", path: ["text"], message: error.message });
    }
    if (parse.blanks.length === 0) {
      ctx.addIssue({ code: "custom", path: ["text"], message: "cloze.no_blank" });
    }
    if (parse.blanks.length > CLOZE_MAX_BLANKS) {
      ctx.addIssue({ code: "custom", path: ["text"], message: "cloze.too_many_blanks" });
    }
  });
export type ClozeConfig = z.infer<typeof ClozeConfigSchema>;

/**
 * One entry per blank, in order of appearance; `null` means untouched.
 * A `select` blank stores the CANONICAL option index as a decimal string, so a
 * shuffled dropdown never changes a stored answer (decision D4).
 */
export const ClozeAnswerSchema = z.object({
  blanks: z.array(z.string().max(CLOZE_MAX_BLANK_LENGTH).nullable()).max(CLOZE_MAX_BLANKS),
});
export type ClozeAnswer = z.infer<typeof ClozeAnswerSchema>;

/**
 * Whether the answer holds something (issue #89): the ONE predicate behind
 * both `isAnswered` hooks, server and client, so the student's list and the
 * teacher's grid can never disagree about it.
 */
export function isClozeAnswered(answer: ClozeAnswer): boolean {
  return answer.blanks.some((blank) => blank !== null && blank.trim() !== "");
}

/**
 * `text`, `number` and `regex` blanks all collapse to `kind: "input"`
 * (`numeric` only drives `inputmode="decimal"`), so a student cannot tell a
 * regex blank from a plain one and no pattern, tolerance or answer leaks.
 */
export const ClozeStudentSchema = z.object({
  /** Markdown carrying the sentinel `⸢<index>⸣` at each blank (decision D5). */
  template: z.string(),
  blanks: z.array(
    z.discriminatedUnion("kind", [
      z.object({
        index: z.number().int(),
        weight: z.number(),
        kind: z.literal("input"),
        numeric: z.boolean(),
      }),
      z.object({
        index: z.number().int(),
        weight: z.number(),
        kind: z.literal("select"),
        options: z.array(z.object({ id: z.number().int(), label: z.string() })),
      }),
    ]),
  ),
});
export type ClozeStudent = z.infer<typeof ClozeStudentSchema>;

/** The key, blank by blank, as `describeBlank` renders it. */
export const ClozeSolutionSchema = z.object({
  blanks: z.array(z.object({ index: z.number().int(), expected: z.string() })),
});
export type ClozeSolution = z.infer<typeof ClozeSolutionSchema>;

/**
 * `expected` is teacher-facing: the student results endpoint strips it unless
 * the feedback policy reveals the key (PLAN-MVP §4.6).
 */
export const ClozeDetailsSchema = z.object({
  perBlank: z.array(
    z.object({
      index: z.number().int(),
      weight: z.number(),
      kind: z.enum(["text", "select", "number", "regex"]),
      ok: z.boolean(),
      given: z.string().nullable(),
      expected: z.string(),
    }),
  ),
  earned: z.number(),
  total: z.number(),
  fraction: z.number(),
});
export type ClozeDetails = z.infer<typeof ClozeDetailsSchema>;

/** See `emptyMcqDraft`: the shape and the defaults, no text, may be invalid. */
export function emptyClozeDraft(): ClozeConfig {
  return {
    configVersion: CLOZE_CONFIG_VERSION,
    text: "",
    caseSensitive: false,
    shuffleOptions: true,
  };
}
