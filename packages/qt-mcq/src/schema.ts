/**
 * The `mcq` schemas (docs/04 §4.4, PLAN-MVP §2.1).
 *
 * Five schemas, one per direction of the contract: what the teacher stores
 * (`McqConfig`), what the student sends (`McqAnswer`), what the student is
 * allowed to see (`McqStudent`), what the feedback may reveal (`McqSolution`)
 * and what the grading stores for the teacher (`McqDetails`).
 */
import { z } from "zod";

/** Bumped when the shape of `McqConfig` changes (stored in `question_versions.config_version`). */
export const MCQ_CONFIG_VERSION = 1;

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
export type McqMode = z.infer<typeof McqModeSchema>;

export const McqPolicySchema = z.enum(["all_or_nothing", "partial", "penalized"]);
export type McqPolicy = z.infer<typeof McqPolicySchema>;

/**
 * The refinements encode the rules that a shape alone cannot: a question with
 * no key cannot be graded, and `single` is exactly one key scored all or
 * nothing. Their messages are i18n keys, never sentences: the editor shows
 * them and `apps/web` translates them.
 */
export const McqConfigSchema = z
  .object({
    configVersion: z.literal(MCQ_CONFIG_VERSION),
    prompt: z.string().min(1).max(20_000),
    choices: z.array(McqChoiceSchema).min(MCQ_MIN_CHOICES).max(MCQ_MAX_CHOICES),
    mode: McqModeSchema.default("single"),
    /** Player-side guard only; a longer payload is truncated, never refused. */
    maxSelections: z.number().int().min(1).max(MCQ_MAX_CHOICES).optional(),
    policy: McqPolicySchema.default("all_or_nothing"),
    /** Fraction of a wrong choice's weight removed under `penalized`. */
    penalty: z.number().min(0).max(1).default(1),
    allowNegative: z.boolean().default(false),
    shuffleChoices: z.boolean().default(true),
  })
  .refine((c) => c.choices.some((x) => x.correct), { message: "mcq.no_correct_choice" })
  .refine((c) => c.mode !== "single" || c.choices.filter((x) => x.correct).length === 1, {
    message: "mcq.single_needs_one",
  })
  .refine((c) => c.mode !== "single" || c.policy === "all_or_nothing", {
    message: "mcq.single_policy",
  });
export type McqConfig = z.infer<typeof McqConfigSchema>;

/** Canonical indices into `config.choices`, ascending and unique (decision D3). */
export const McqAnswerSchema = z.object({
  selected: z.array(z.number().int().min(0).max(MCQ_MAX_CHOICES - 1)).max(MCQ_MAX_CHOICES),
});
export type McqAnswer = z.infer<typeof McqAnswerSchema>;

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
 * The config of a fresh draft. It must validate (PLAN-MVP §8 WP2), and every
 * string of the schema is non-empty, so the placeholders are the language-free
 * ellipsis rather than an English sentence the teacher would have to delete.
 */
export function emptyMcqDraft(): McqConfig {
  return McqConfigSchema.parse({
    configVersion: MCQ_CONFIG_VERSION,
    prompt: "…",
    choices: [
      { text: "…", correct: true },
      { text: "…", correct: false },
    ],
  });
}

/** Canonical indices of the correct choices, ascending. */
export function correctIndices(config: McqConfig): number[] {
  return config.choices.flatMap((choice, index) => (choice.correct ? [index] : []));
}
