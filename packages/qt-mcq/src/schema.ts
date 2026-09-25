/**
 * The `mcq` schemas (docs/04 §4.4, PLAN-MVP §2.1).
 *
 * Five schemas, one per direction of the contract: what the teacher stores
 * (`McqConfig`), what the student sends (`McqAnswer`), what the student is
 * allowed to see (`McqStudent`), what the feedback may reveal (`McqSolution`)
 * and what the grading stores for the teacher (`McqDetails`).
 */
import { MCQ_SCORE_POLICIES } from "@quiz/domain/mcqScore";
import { z } from "zod";

/** Bumped when the shape of `McqConfig` changes (stored in `question_versions.config_version`). */
export const MCQ_CONFIG_VERSION = 2;

/** docs/04 §4.4: at least two choices, at most twelve (a longer list is a reading exercise). */
export const MCQ_MIN_CHOICES = 2;
export const MCQ_MAX_CHOICES = 12;

export const McqChoiceSchema = z.object({
  /** Markdown, like the prompt: a choice is often a code fragment. */
  text: z.string().min(1).max(2000),
  correct: z.boolean().default(false),
});
export type McqChoice = z.infer<typeof McqChoiceSchema>;

export const McqModeSchema = z.enum(["single", "multiple"]);

/**
 * How a `multiple` question is scored (docs/04 §4.4; `@quiz/domain/mcqScore`
 * holds the formulas). A `single` question is always all or nothing, whatever
 * this says: with one key there is nothing to be partial about.
 *
 *   all_or_nothing : the exact key set, or nothing
 *   true_false     : every choice is its own true/false item; the share of
 *                    choices answered right
 *   discordance    : by distance to the key: 0 → 1, 1 → 0.5, 2 → 0.2, more → 0
 *   symmetric      : +1/C per correct tick, −1/W per wrong tick, floored at 0
 *                    (random ticking has a zero expectation)
 *   ripkey         : the share of correct ticks, cancelled by any wrong tick
 */
export const McqPolicySchema = z.enum(MCQ_SCORE_POLICIES);
export type McqPolicy = z.infer<typeof McqPolicySchema>;

/**
 * What a QUESTION stores: one of the policies, or `inherit` — the evaluation
 * that plays it decides (its own setting, seeded from the teacher's
 * preference). The grader resolves it through `GradeContext.defaults`.
 */
export const McqQuestionPolicySchema = z.enum(["inherit", ...McqPolicySchema.options]);
export type McqQuestionPolicy = z.infer<typeof McqQuestionPolicySchema>;

/**
 * The `mcq` entry of `GradeContext.defaults`: the evaluation's own policy,
 * what an `inherit` question defers to. `GradeContext.defaults` is typed
 * `Record<string, unknown>` — the core knows no type's settings — so the type
 * parses its own entry and falls back to `all_or_nothing` when it is absent
 * (the teacher's Try panel, which has no evaluation).
 */
export const McqDefaultsSchema = z.object({ policy: McqPolicySchema });

const McqConfigShape = z.object({
  configVersion: z.literal(MCQ_CONFIG_VERSION),
  prompt: z.string().min(1).max(20_000),
  choices: z.array(McqChoiceSchema).min(MCQ_MIN_CHOICES).max(MCQ_MAX_CHOICES),
  mode: McqModeSchema.default("single"),
  /** Player-side guard only; a longer payload is truncated, never refused. */
  maxSelections: z.number().int().min(1).max(MCQ_MAX_CHOICES).optional(),
  policy: McqQuestionPolicySchema.default("inherit"),
  shuffleChoices: z.boolean().default(true),
});

/**
 * The refinements encode the rules that a shape alone cannot: a question with
 * no key cannot be graded, and `single` is exactly one key scored all or
 * nothing. Their messages are i18n keys, never sentences: the editor shows
 * them and `apps/web` translates them.
 */
export const McqConfigSchema = McqConfigShape
  .refine((c) => c.choices.some((x) => x.correct), { message: "mcq.no_correct_choice" })
  .refine((c) => c.mode !== "single" || c.choices.filter((x) => x.correct).length === 1, {
    message: "mcq.single_needs_one",
  })
  // A cap below the size of the key would make the full mark unreachable.
  .refine(
    (c) => c.maxSelections === undefined || c.maxSelections >= c.choices.filter((x) => x.correct).length,
    { message: "mcq.max_below_correct", path: ["maxSelections"] },
  );

/**
 * The same question with the key OPTIONAL: an opinion poll (ADR-014, addendum
 * 2026-09-23). No choice has to be correct; when some are, the rules of the
 * key still hold — `single` means at most one, and the cap stays above it.
 */
export const McqKeylessConfigSchema = McqConfigShape
  .refine((c) => c.mode !== "single" || c.choices.filter((x) => x.correct).length <= 1, {
    message: "mcq.single_needs_one",
  })
  .refine(
    (c) => c.maxSelections === undefined || c.maxSelections >= c.choices.filter((x) => x.correct).length,
    { message: "mcq.max_below_correct", path: ["maxSelections"] },
  );
export type McqConfig = z.infer<typeof McqConfigSchema>;

/** Canonical indices into `config.choices`, ascending and unique (decision D3). */
export const McqAnswerSchema = z.object({
  selected: z.array(z.number().int().min(0).max(MCQ_MAX_CHOICES - 1)).max(MCQ_MAX_CHOICES),
});
export type McqAnswer = z.infer<typeof McqAnswerSchema>;

/**
 * Whether the answer holds something (issue #89): the ONE predicate behind
 * both `isAnswered` hooks, server and client, so the student's list and the
 * teacher's grid can never disagree about it.
 */
export function isMcqAnswered(answer: McqAnswer): boolean {
  return answer.selected.length > 0;
}

/**
 * Letter of a choice, as the editor, the review and the live grid show it:
 * A, B, C… It lives with the schemas rather than in `ui.tsx` because both
 * halves of the package need it and the server half may not touch React.
 */
export function choiceLetter(index: number): string {
  return String.fromCharCode(65 + (index % 26));
}

/**
 * What `toStudent` may emit. `id` is the canonical index and the ARRAY ORDER is
 * the shuffled display order (decision D3): the answer is always canonical, the
 * display never is.
 */
export const McqStudentSchema = z.object({
  prompt: z.string(),
  choices: z.array(z.object({ id: z.number().int(), text: z.string() })),
  mode: McqModeSchema,
  maxSelections: z.number().int().optional(),
});
export type McqStudent = z.infer<typeof McqStudentSchema>;

export const McqSolutionSchema = z.object({ correct: z.array(z.number().int()) });
export type McqSolution = z.infer<typeof McqSolutionSchema>;

/** `C`/`W` are the key's counts, `c`/`w` the student's hits and misses (§7.3). */
export const McqDetailsSchema = z.object({
  /** The policy that was APPLIED, `inherit` resolved. */
  policy: McqPolicySchema,
  correct: z.array(z.number().int()),
  selected: z.array(z.number().int()),
  c: z.number().int(),
  w: z.number().int(),
  C: z.number().int(),
  W: z.number().int(),
  fraction: z.number(),
  /** `maxSelections` dropped part of the payload; the answer was never refused. */
  truncated: z.boolean(),
});
export type McqDetails = z.infer<typeof McqDetailsSchema>;

/**
 * The config of a fresh draft: the shape, the defaults, and NO content.
 *
 * It does not validate — an empty prompt and two empty choices are exactly
 * what `configSchema` refuses — and that is the point: decision D16 stores a
 * draft whatever it holds, and publication is the gate. A placeholder would
 * only be text the teacher has to select and delete first.
 */
export function emptyMcqDraft(): McqConfig {
  return {
    configVersion: MCQ_CONFIG_VERSION,
    prompt: "",
    choices: [
      { text: "", correct: true },
      { text: "", correct: false },
    ],
    mode: "single",
    policy: "inherit",
    shuffleChoices: true,
  };
}

/** Canonical indices of the correct choices, ascending. */
export function correctIndices(config: McqConfig): number[] {
  return config.choices.flatMap((choice, index) => (choice.correct ? [index] : []));
}
