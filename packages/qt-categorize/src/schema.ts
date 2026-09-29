/**
 * The `categorize` schemas (docs/spec/04 §4.13, ADR-036), shown as
 * "Categorize" / « Classement »: cards to sort into columns.
 *
 * The KEY lives inside the columns: each column lists the ids of the cards
 * that belong in it, in order. A card listed by no column is a DISTRACTOR,
 * which the student is expected to leave in the tray. One card belongs to one
 * column at most.
 *
 * Every id is OPAQUE — a short random string the editor mints — and never an
 * index nor a label: the student sees the card and column ids (the answer is
 * written with them), so an id must say nothing about where a card goes.
 */
import { CATEGORIZE_SCORE_POLICIES } from "@quiz/domain/categorizeScore";
import { z } from "zod";

export const CATEGORIZE_CONFIG_VERSION = 1;

/** Two columns at least (one column is not a choice); six fit a laptop's width. */
export const CATEGORIZE_MIN_COLUMNS = 2;
export const CATEGORIZE_MAX_COLUMNS = 6;
/** A longer list is a reading exercise, and the tray stops fitting a screen. */
export const CATEGORIZE_MAX_CARDS = 30;

/**
 * An id minted by the editor ({@link newId}): lowercase letters and digits,
 * bounded so an answer stays small. The charset keeps a crafted id from
 * carrying anything but an identity (no markup, no path, no whitespace).
 */
const IdSchema = z.string().regex(/^[a-z0-9]{4,40}$/);

/** The longest card text: a word, an expression, a line or two of code. */
export const CATEGORIZE_CARD_MAX = 500;
/** The longest column label. */
export const CATEGORIZE_LABEL_MAX = 200;

export const CategorizeCardSchema = z.object({
  id: IdSchema,
  /** Short markdown: inline code and formulas, one or two lines. */
  text: z.string().min(1).max(CATEGORIZE_CARD_MAX),
});
export type CategorizeCard = z.infer<typeof CategorizeCardSchema>;

export const CategorizeColumnSchema = z.object({
  id: IdSchema,
  label: z.string().min(1).max(CATEGORIZE_LABEL_MAX),
  /** The KEY: ids of the cards that belong here, in the expected order. */
  cards: z.array(IdSchema).max(CATEGORIZE_MAX_CARDS).default([]),
});
export type CategorizeColumn = z.infer<typeof CategorizeColumnSchema>;

export const CategorizePolicySchema = z.enum(CATEGORIZE_SCORE_POLICIES);
export type CategorizePolicy = z.infer<typeof CategorizePolicySchema>;

/** What a QUESTION stores: a policy, or `inherit` — the evaluation's own setting decides. */
export const CategorizeQuestionPolicySchema = z.enum(["inherit", ...CategorizePolicySchema.options]);
export type CategorizeQuestionPolicy = z.infer<typeof CategorizeQuestionPolicySchema>;

/**
 * The `categorize` entry of `GradeContext.defaults` (and `StudentView.defaults`):
 * the evaluation's policy, what an `inherit` question defers to, and its
 * negative marking (ADR-026, extended by ADR-036). Absent — the teacher's Try
 * panel — the type falls back to `per_item` without negative marking.
 */
export const CategorizeDefaultsSchema = z.object({
  policy: CategorizePolicySchema,
  negativeMarking: z.boolean().optional(),
});
export type CategorizeDefaults = z.infer<typeof CategorizeDefaultsSchema>;

const unique = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;

/**
 * The refinements say what a shape cannot: ids are unique, the key names
 * cards that exist, a card sits in one column at most, and at least one card
 * belongs somewhere — a question made of distractors only has no answer.
 * Messages are i18n keys (`apps/web/src/question/issues.ts` maps them), and
 * each names `columns`, so the editor shows it under the board it is about.
 */
export const CategorizeConfigSchema = z
  .object({
    configVersion: z.literal(CATEGORIZE_CONFIG_VERSION),
    prompt: z.string().min(1).max(20_000),
    columns: z.array(CategorizeColumnSchema).min(CATEGORIZE_MIN_COLUMNS).max(CATEGORIZE_MAX_COLUMNS),
    cards: z.array(CategorizeCardSchema).min(1).max(CATEGORIZE_MAX_CARDS),
    /** Within each column, the rank of a card counts too. */
    ordered: z.boolean().default(false),
    /** Each student gets the cards in an order of their own (seeded by the attempt). */
    shuffleCards: z.boolean().default(true),
    /** Off by default: the order of the columns often means something ("before / after"). */
    shuffleColumns: z.boolean().default(false),
    policy: CategorizeQuestionPolicySchema.default("inherit"),
  })
  .refine((c) => unique(c.columns.map((col) => col.id)) && unique(c.cards.map((card) => card.id)), {
    message: "categorize.duplicate_id",
    path: ["columns"],
  })
  .refine(
    (c) => {
      const known = new Set(c.cards.map((card) => card.id));
      return c.columns.every((col) => col.cards.every((id) => known.has(id)));
    },
    { message: "categorize.unknown_card", path: ["columns"] },
  )
  .refine((c) => unique(c.columns.flatMap((col) => col.cards)), { message: "categorize.card_twice", path: ["columns"] })
  .refine((c) => c.columns.some((col) => col.cards.length > 0), { message: "categorize.no_target", path: ["columns"] });
export type CategorizeConfig = z.infer<typeof CategorizeConfigSchema>;

/**
 * Where the student put the cards: column id → card ids, in order. A card in
 * no column is in the tray. The shape rules that need the config (known ids,
 * one column per card) are `answerMisfit`'s.
 */
export const CategorizeAnswerSchema = z.object({
  columns: z
    .record(IdSchema, z.array(IdSchema).max(CATEGORIZE_MAX_CARDS))
    .refine((r) => Object.keys(r).length <= CATEGORIZE_MAX_COLUMNS),
});
export type CategorizeAnswer = z.infer<typeof CategorizeAnswerSchema>;

/** Issue #89: the ONE predicate behind both `isAnswered` hooks — a card is placed. */
export function isCategorizeAnswered(answer: CategorizeAnswer): boolean {
  return Object.values(answer.columns).some((ids) => ids.length > 0);
}

/**
 * What a student may see: the statement, the columns WITHOUT their cards, the
 * cards in the display order, and whether the order counts — a rule of the
 * question the student must know before answering. The array order of
 * `columns` and `cards` is the display order; the ids are canonical.
 */
export const CategorizeStudentSchema = z.object({
  prompt: z.string(),
  columns: z.array(z.object({ id: z.string(), label: z.string() })),
  cards: z.array(z.object({ id: z.string(), text: z.string() })),
  ordered: z.boolean(),
  /** The evaluation scores with negative marking (ADR-026): the student is told. */
  negativeMarking: z.literal(true).optional(),
});
export type CategorizeStudent = z.infer<typeof CategorizeStudentSchema>;

/** The key, served only when the feedback policy publishes it. */
export const CategorizeSolutionSchema = z.object({
  columns: z.array(z.object({ id: z.string(), cards: z.array(z.string()) })),
});
export type CategorizeSolution = z.infer<typeof CategorizeSolutionSchema>;

/**
 * The verdict of one card. `expected` (the column the key puts it in, `null`
 * for a distractor) and `expectedRank` are the answer key: `studentDetails`
 * drops them when the key is not published. `placed` and `rank` are the
 * student's own answer; ranks are 1-based.
 */
export const CategorizeCardVerdictSchema = z.object({
  id: z.string(),
  placed: z.string().nullable(),
  rank: z.number().int().optional(),
  expected: z.string().nullable().optional(),
  expectedRank: z.number().int().optional(),
  right: z.boolean(),
});
export type CategorizeCardVerdict = z.infer<typeof CategorizeCardVerdictSchema>;

/**
 * A card's verdict as a STUDENT may read it when the key is not published
 * (`studentDetails`): the student's own place, and `right` only for a card
 * they placed — the verdict on a card left in the tray would say whether it
 * was a distractor, which is the key.
 */
export type CategorizeStudentCardVerdict = Omit<CategorizeCardVerdict, "expected" | "expectedRank" | "right"> & {
  right?: boolean;
};

/** The counts of `@quiz/domain/categorizeScore`, the policy that applied, and per card. */
export const CategorizeDetailsSchema = z.object({
  /** The question's policy, `inherit` resolved. */
  policy: CategorizePolicySchema,
  /** The evaluation's negative marking scored this answer: the fraction lies in [−1, 1]. */
  negativeMarking: z.boolean().optional(),
  ordered: z.boolean(),
  cards: z.array(CategorizeCardVerdictSchema),
  T: z.number().int(),
  D: z.number().int(),
  t: z.number().int(),
  x: z.number().int(),
  p: z.number().int(),
  fraction: z.number(),
});
export type CategorizeDetails = z.infer<typeof CategorizeDetailsSchema>;

/**
 * A fresh opaque id: eight base-36 characters. `crypto.getRandomValues`
 * exists in every browser and in Node ≥ 19, the two places an editor or a
 * seed runs.
 */
export function newId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

/** See `emptyMcqDraft`: the shape and the defaults, no content, may be invalid (D16). */
export function emptyCategorizeDraft(): CategorizeConfig {
  return {
    configVersion: CATEGORIZE_CONFIG_VERSION,
    prompt: "",
    columns: [
      { id: newId(), label: "", cards: [] },
      { id: newId(), label: "", cards: [] },
    ],
    cards: [],
    ordered: false,
    shuffleCards: true,
    shuffleColumns: false,
    policy: "inherit",
  };
}

/**
 * The details a review reads: the teacher's whole {@link CategorizeDetails},
 * or the student's redacted copy — no `T` nor `D` (together they count the
 * distractors) and no verdict on an unplaced card. `CategorizeDetails` fits
 * this shape, so one review reads both.
 */
export type CategorizeReviewDetails = Omit<CategorizeDetails, "T" | "D" | "cards"> & {
  T?: number;
  D?: number;
  cards: CategorizeStudentCardVerdict[];
};
