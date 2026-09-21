/**
 * The `cloze` schemas (docs/04 §4.6, PLAN-MVP §2.3).
 *
 * The `{{…}}` grammar itself lives in `@quiz/domain/cloze` — parser, student
 * projection and grader — and is NOT re-implemented here: the editor preview,
 * `toStudent` and the grading all call the same `parseCloze`, so what the
 * teacher sees, what the student plays and what is graded cannot drift.
 */
import { parseCloze } from "@quiz/domain";
import { z } from "zod";

/** v2 adds `choiceSets`; v1 is the same question with an empty list. */
export const CLOZE_CONFIG_VERSION = 2;

/** docs/04: a cloze holds at most fifty blanks, and an answer at most 200 characters. */
export const CLOZE_MAX_BLANKS = 50;
export const CLOZE_MAX_BLANK_LENGTH = 200;

/** docs/04 §4.6: twenty sets per question, two to twelve options each. */
export const CLOZE_MAX_CHOICE_SETS = 20;
export const CLOZE_MIN_SET_OPTIONS = 2;
export const CLOZE_MAX_SET_OPTIONS = 12;
export const CLOZE_MAX_SET_KEY_LENGTH = 32;
export const CLOZE_MAX_OPTION_LENGTH = 200;

/**
 * A PREDEFINED CHOICE SET: the options of a dropdown, written once and reused
 * in the text as `{{<key>}}` (docs/04 §4.6).
 *
 * It is what makes a dropdown possible inside a markdown TABLE, where the
 * `{{=a|b|c}}` spelling cannot go: every unescaped `|` there is a column
 * separator. `@quiz/domain`'s `parseCloze` resolves the key back to an
 * ordinary `select` blank, so nothing downstream gains a case.
 */
export const ClozeChoiceSetSchema = z.object({
  key: z.string().min(1).max(CLOZE_MAX_SET_KEY_LENGTH),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(CLOZE_MAX_OPTION_LENGTH),
        correct: z.boolean().default(false),
      }),
    )
    // Our own i18n key rather than zod's sentence: a `qt-*` package emits keys
    // and the host decides the wording (`IssueList` in ui.tsx).
    .min(CLOZE_MIN_SET_OPTIONS, "cloze.set_too_small")
    .max(CLOZE_MAX_SET_OPTIONS),
});
export type ClozeChoiceSet = z.infer<typeof ClozeChoiceSetSchema>;

export const ClozeConfigSchema = z
  .object({
    configVersion: z.literal(CLOZE_CONFIG_VERSION),
    /** Markdown with `{{…}}` holes; blanks inside a fenced code block stay active. */
    text: z.string().min(1).max(20_000),
    caseSensitive: z.boolean().default(false),
    shuffleOptions: z.boolean().default(true),
    /** Reusable dropdowns, addressed from the text by their key. */
    choiceSets: z.array(ClozeChoiceSetSchema).max(CLOZE_MAX_CHOICE_SETS).default([]),
  })
  .superRefine((config, ctx) => {
    /*
     * The sets are handed to the SAME parser the grader and `toStudent` call,
     * so a `{{1}}` the teacher sees as a dropdown here is a dropdown there.
     */
    const parse = parseCloze(config.text, config.choiceSets);
    for (const error of parse.errors) {
      ctx.addIssue({ code: "custom", path: ["text"], message: error.message });
    }
    if (parse.blanks.length === 0) {
      ctx.addIssue({ code: "custom", path: ["text"], message: "cloze.no_blank" });
    }
    if (parse.blanks.length > CLOZE_MAX_BLANKS) {
      ctx.addIssue({ code: "custom", path: ["text"], message: "cloze.too_many_blanks" });
    }
    const seen = new Set<string>();
    config.choiceSets.forEach((set, i) => {
      // A key is what a hole names, so two sets under one name would make
      // `{{1}}` mean whichever the parser met first: refused, not resolved.
      if (seen.has(set.key)) {
        ctx.addIssue({ code: "custom", path: ["choiceSets", i], message: "cloze.set_duplicate_key" });
      }
      seen.add(set.key);
      if (!set.options.some((option) => option.correct)) {
        ctx.addIssue({ code: "custom", path: ["choiceSets", i], message: "cloze.set_no_correct" });
      }
    });
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
    choiceSets: [],
  };
}
