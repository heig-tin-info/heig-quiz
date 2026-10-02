/**
 * `grading` route schemas (PLAN-MVP §4.5 and §3.5).
 *
 * The grading panel is a read model over `gradings`: one entry per
 * (attempt, item) pair, one question at a time, and anonymous unless the
 * teacher asks for the names — an anonymous entry carries NO label at all,
 * not a pseudonym (F-GRADE-03, ADR-044).
 *
 * `answerId` is NULLABLE here for the same reason it is nullable in the
 * table: an absent answer is still graded — zero points, validated, `auto`
 * (F-GRADE-01) — and there is no `answers` row to hang it on.
 */
import { z } from "zod";

import { NamedValues, ParametersDraft } from "./parameters.js";
import { VersionRow } from "./pool.js";

/** Who produced a grading. `llm` is phase 2 and only ever `proposed` in MVP. */
export const GradingSource = z.enum(["auto", "llm", "manual"]);
export type GradingSource = z.infer<typeof GradingSource>;

/**
 * `validated` counts towards the grade; `proposed` waits for the teacher;
 * `superseded` is history. At most one `validated` grading per answer, held
 * by a partial unique index.
 */
export const GradingState = z.enum(["proposed", "validated", "superseded"]);
export type GradingState = z.infer<typeof GradingState>;

export const GradingConfidence = z.enum(["low", "medium", "high"]);
export type GradingConfidence = z.infer<typeof GradingConfidence>;

/*
 * Why a machine PROPOSED instead of grading, which of those a new pass may
 * clear, and `reasonOf`: closed once in `@quiz/core/reasons`, where the
 * question types' grading columns (`@quiz/ui`) read them too, and
 * re-exported here for the routes and the web.
 */
export {
  AI_KEY,
  aiOf,
  isMachineReason,
  isRetryableReason,
  INSTANCE_WARNING_KEY,
  JUSTIFICATION_KEY,
  justificationOf,
  MACHINE_REASONS,
  PASS_REASONS,
  reasonOf,
  RETRYABLE_REASONS,
  type AiDetails,
  type MachineReason,
  type PassReason,
} from "@quiz/core/reasons";

/** The verdict a cell of the dashboard and of the results grid shows. */
export const Verdict = z.enum(["correct", "partial", "wrong", "pending"]);
export type Verdict = z.infer<typeof Verdict>;

export const Grading = z.object({
  id: z.uuid(),
  answerId: z.uuid().nullable(),
  attemptId: z.uuid(),
  itemId: z.uuid(),
  points: z.number(),
  maxPoints: z.number(),
  source: GradingSource,
  state: GradingState,
  /** Type-specific breakdown, exactly as `type.grade` produced it. */
  details: z.unknown().nullable(),
  confidence: GradingConfidence.nullable(),
  comment: z.string().nullable(),
  gradedBy: z.uuid().nullable(),
  gradedAt: z.iso.datetime(),
  supersedesId: z.uuid().nullable(),
  /** "re-graded with version N" (F-GRADE-06). */
  regradeNote: z.string().nullable(),
});
export type Grading = z.infer<typeof Grading>;

/** One line of the per-answer history, newest first. */
export const GradingHistoryEntry = z.object({
  id: z.uuid(),
  points: z.number(),
  maxPoints: z.number(),
  source: GradingSource,
  state: GradingState,
  gradedAt: z.iso.datetime(),
  comment: z.string().nullable(),
  regradeNote: z.string().nullable(),
});
export type GradingHistoryEntry = z.infer<typeof GradingHistoryEntry>;

export const GradingQueueItem = z.object({
  id: z.uuid(),
  position: z.number().int(),
  internalName: z.string(),
  type: z.string(),
  points: z.number(),
  /**
   * The lowest points a manual correction may give (F-GRADE-05): 0, or
   * `-points` for a choice question of an evaluation with negative marking
   * (ADR-026). The highest is `points`. The server always sends it; absent
   * reads as 0.
   */
  minPoints: z.number().optional(),
  /**
   * The question's explanation, an aid beside the answer being graded; the
   * server sends it (`null`: none; absent in older fixtures). Teacher-facing only.
   */
  explanation: z.string().nullable().optional(),
  /**
   * A parameterized question (ADR-056 §9): absent for a static one. Its
   * answers each have their own key, so the expected row does not show one
   * student's numbers: it shows `template`, the question as written, with
   * its `[[…]]` (mcq, short), or — when the template alone is not a
   * question the type can draw (a cloze `{{#[[t]]:1%}}`) — the instance of
   * the example values, `example: true`, which the table then names as
   * such. `variables` is the table the teacher wrote. Staff-only, like the
   * whole queue.
   */
  parameters: z
    .object({
      variables: ParametersDraft,
      template: z.object({ student: z.unknown(), solution: z.unknown(), example: z.boolean() }),
    })
    .optional(),
});
export type GradingQueueItem = z.infer<typeof GradingQueueItem>;

export const GradingEntry = z.object({
  answerId: z.uuid().nullable(),
  attemptId: z.uuid(),
  itemId: z.uuid(),
  /**
   * The student's display name when `?anonymous=0`; `null` by default, and
   * then nothing else in the entry names the student either (F-GRADE-03,
   * ADR-044).
   */
  label: z.string().nullable(),
  /**
   * A GUEST's number among the evaluation's guests (ADR-014), when names
   * are asked for: a guest has no name, and the web words it ("Guest 2")
   * in the reader's language. `null` anonymised, and for an account.
   */
  guest: z.number().int().positive().nullable(),
  /**
   * The attempt is a teacher's own staff test (ADR-018). Sent anonymous or
   * not: it says whose answer this is not, rather than whose it is.
   */
  staff: z.boolean(),
  /**
   * Which of a student's attempts this is (ADR-025), `null` when the student
   * holds only one — every exam. A number, never a name, so it is sent
   * anonymous too: two answers of one student to one question must not read
   * as two students.
   */
  attemptNumber: z.number().int().positive().nullable(),
  /**
   * The attempt is the one that counts for its student (ADR-025, `best` or
   * `last`); always true for a student with one attempt.
   */
  kept: z.boolean(),
  answer: z.unknown().nullable(),
  /**
   * A parameterized question's values for this attempt (ADR-056 §9), in the
   * table's order, each written with its row's format — what the student
   * read; `student` and `solution` are this instance's. Absent for a static
   * question.
   */
  values: NamedValues.optional(),
  /**
   * Beside `values`: the explanation instantiated with them (`null`: none),
   * where the item's is the template's. Absent for a static question.
   */
  explanation: z.string().nullable().optional(),
  /** The question as the student saw it, through `studentView()`. */
  student: z.unknown(),
  solution: z.unknown(),
  grading: Grading.nullable(),
  history: z.array(GradingHistoryEntry),
});
export type GradingEntry = z.infer<typeof GradingEntry>;

export const GradingQueue = z.object({
  items: z.array(GradingQueueItem),
  entries: z.array(GradingEntry),
  counts: z.object({
    total: z.number().int(),
    validated: z.number().int(),
    proposed: z.number().int(),
    missing: z.number().int(),
  }),
});
export type GradingQueue = z.infer<typeof GradingQueue>;

/**
 * `?itemId=&anonymous=1`. Grading is by question (ADR-044): the panel reads
 * one item's answers at a time, every state, and filters them itself;
 * without `itemId`, every item's.
 */
export const GradingQuery = z.object({
  itemId: z.uuid().optional(),
  anonymous: z
    .union([z.string(), z.boolean()])
    .default(true)
    .transform((v) => !(v === false || v === "0" || v === "false")),
});
export type GradingQuery = z.infer<typeof GradingQuery>;

/**
 * `GET /evaluations/:id/grading/steps` — one step per question, in the
 * order of the evaluation, each with the state of its cells (#107): the
 * question selector and its stepper are drawn without downloading a single
 * answer. The queue carries whole answers and solutions, this carries two
 * counters per question.
 */
const GradingStepSummary = z.object({
  /** The item id. */
  key: z.uuid(),
  total: z.number().int(),
  validated: z.number().int(),
});

export const GradingSteps = z.object({
  steps: z.array(GradingStepSummary),
});
export type GradingSteps = z.infer<typeof GradingSteps>;

/** `GET /evaluations/:id/grading/progress` */
export const GradingProgress = z.object({
  done: z.number().int(),
  total: z.number().int(),
  pending: z.object({ runner: z.number().int(), llm: z.number().int() }),
  failed: z.number().int(),
});
export type GradingProgress = z.infer<typeof GradingProgress>;

/** `POST /evaluations/:id/grading/run` — only pending and missing answers. */
export const GradingRunBody = z.object({
  itemIds: z.array(z.uuid()).max(200).optional(),
});
export type GradingRunBody = z.infer<typeof GradingRunBody>;

/**
 * Each request is its own job (#273), and neither pg-boss nor the
 * in-process development runner hands back a usable job id, so the
 * acknowledgement names the work instead of a ticket (deviation W6-4).
 */
export const GradingRunAccepted = z.object({
  evaluationId: z.uuid(),
  itemIds: z.array(z.uuid()),
  queued: z.boolean(),
});
export type GradingRunAccepted = z.infer<typeof GradingRunAccepted>;

/** F-GRADE-05: the comment is mandatory, the previous grading is superseded. */
export const ManualGradingBody = z.object({
  points: z.number().min(-1000).max(1000),
  comment: z.string().trim().min(1).max(4000),
});
export type ManualGradingBody = z.infer<typeof ManualGradingBody>;

/** F-GRADE-04: validate a proposal, possibly adjusting it on the way. */
export const ValidateGradingBody = z.object({
  points: z.number().min(-1000).max(1000).optional(),
  comment: z.string().trim().max(4000).optional(),
});
export type ValidateGradingBody = z.infer<typeof ValidateGradingBody>;

/** F-GRADE-04: "every high-confidence proposal of question 3", in one call. */
export const BatchValidateBody = z.object({
  itemId: z.uuid().optional(),
  source: GradingSource.optional(),
  confidence: GradingConfidence.optional(),
  state: z.literal("proposed").default("proposed"),
});
export type BatchValidateBody = z.infer<typeof BatchValidateBody>;

export const BatchValidateResponse = z.object({ validated: z.number().int() });
export type BatchValidateResponse = z.infer<typeof BatchValidateResponse>;

/** F-GRADE-06. `toVersionNumber` repoints the item at a newer version first. */
export const RegradeBody = z.object({
  note: z.string().trim().min(1).max(500),
  toVersionNumber: z.number().int().positive().optional(),
});
export type RegradeBody = z.infer<typeof RegradeBody>;

/**
 * `GET /evaluations/:id/items/:itemId/versions`: what the regrade sheet
 * offers (issue #106). Every published version of the item's question,
 * newest first, and the number the evaluation froze. Reached through the
 * evaluation's staff, not the pool's roster: a teacher who may grade must
 * always see the versions of what they grade, even when the question's pool
 * is no longer linked to the course.
 */
export const ItemVersions = z.object({
  frozenNumber: z.number().int().positive(),
  versions: z.array(VersionRow),
});
export type ItemVersions = z.infer<typeof ItemVersions>;

/** `/answers/:answerId/gradings` */
export const AnswerIdParam = z.object({ answerId: z.uuid() });
export type AnswerIdParam = z.infer<typeof AnswerIdParam>;

/** `/gradings/:id/…` */
export const GradingIdParam = z.object({ id: z.uuid() });
export type GradingIdParam = z.infer<typeof GradingIdParam>;
