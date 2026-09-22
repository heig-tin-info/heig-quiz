/**
 * `grading` route schemas (PLAN-MVP §4.5 and §3.5).
 *
 * The grading panel is a read model over `gradings`: one entry per
 * (attempt, item) pair, ordered by question or by student, with the student's
 * name replaced by a stable pseudonym unless the teacher asks for the names
 * (F-GRADE-03, decision D20).
 *
 * `answerId` is NULLABLE here for the same reason it is nullable in the
 * table: an absent answer is still graded — zero points, validated, `auto`
 * (F-GRADE-01) — and there is no `answers` row to hang it on.
 */
import { z } from "zod";

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
});
export type GradingQueueItem = z.infer<typeof GradingQueueItem>;

export const GradingEntry = z.object({
  answerId: z.uuid().nullable(),
  attemptId: z.uuid(),
  itemId: z.uuid(),
  /** Pseudonym by default, display name when `?anonymous=0` (F-GRADE-03). */
  label: z.string(),
  /** The attempt is a teacher's own staff test (ADR-018), badged as such. */
  staff: z.boolean(),
  answer: z.unknown().nullable(),
  /** The question as the student saw it, through `studentView()`. */
  student: z.unknown(),
  solution: z.unknown(),
  grading: Grading.nullable(),
  history: z.array(GradingHistoryEntry),
});
export type GradingEntry = z.infer<typeof GradingEntry>;

export const GradingQueue = z.object({
  order: z.enum(["question", "student"]),
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

/** `?by=question|student&itemId=&attemptId=&state=&anonymous=1` */
export const GradingQuery = z.object({
  by: z.enum(["question", "student"]).default("question"),
  itemId: z.uuid().optional(),
  attemptId: z.uuid().optional(),
  state: GradingState.optional(),
  anonymous: z
    .union([z.string(), z.boolean()])
    .default(true)
    .transform((v) => !(v === false || v === "0" || v === "false")),
});
export type GradingQuery = z.infer<typeof GradingQuery>;

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
 * The queue is a singleton per evaluation, and neither pg-boss nor the
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
  details: z.unknown().optional(),
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

/** `/answers/:answerId/gradings` */
export const AnswerIdParam = z.object({ answerId: z.uuid() });
export type AnswerIdParam = z.infer<typeof AnswerIdParam>;

/** `/gradings/:id/…` */
export const GradingIdParam = z.object({ id: z.uuid() });
export type GradingIdParam = z.infer<typeof GradingIdParam>;
