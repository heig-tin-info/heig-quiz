/**
 * `stats` route schemas: the item analysis of a question in its pool
 * (ADR-038, F-STAT-01…05).
 *
 * A question's statistics are the mean success rate `p` over the `n`
 * answers counted. The server applies the threshold: below
 * `QUESTION_STATS_MIN_N` answers (`@quiz/domain`) a question is absent from
 * the pool list — a smaller `n` never goes on the wire. `p` is SIGNED: negative marking (ADR-026) can push it below
 * zero.
 *
 * The time spent on a question (ADR-039) has its own threshold,
 * `QUESTION_TIME_MIN_N` timed exam answers: below it `time` is null while
 * `n` and `p` show. Whole seconds.
 *
 * The discrimination index (ADR-040) is null when no exam qualifies for it
 * (five other items, ten attempts whose every item is validated).
 */
import { z } from "zod";

export const ItemStats = z.object({
  n: z.number().int().nonnegative(),
  p: z.number(),
});
export type ItemStats = z.infer<typeof ItemStats>;

/** The time a question stays on screen, over `n` timed exam answers, in whole seconds. */
export const TimeStats = z.object({
  n: z.number().int().nonnegative(),
  meanS: z.number().int().nonnegative(),
  medianS: z.number().int().nonnegative(),
  p25S: z.number().int().nonnegative(),
  p75S: z.number().int().nonnegative(),
});
export type TimeStats = z.infer<typeof TimeStats>;

/**
 * A question's discrimination index (ADR-040): the corrected point-biserial,
 * combined over `evaluations` exams and `n` attempts, to two decimals. Signed.
 */
export const DiscriminationStats = z.object({
  r: z.number().min(-1).max(1),
  evaluations: z.number().int().positive(),
  n: z.number().int().positive(),
});
export type DiscriminationStats = z.infer<typeof DiscriminationStats>;

/**
 * One question's statistics, where they start (the last reset, null when
 * there was none), its time — null below its own threshold — and its
 * discrimination, null when no exam qualifies.
 */
export const QuestionStats = ItemStats.extend({
  since: z.string().nullable(),
  time: TimeStats.nullable(),
  discrimination: DiscriminationStats.nullable(),
});
export type QuestionStats = z.infer<typeof QuestionStats>;

/** `GET /pools/:id/question-stats`: one entry per question that has enough answers. */
export const PoolQuestionStats = z.object({
  items: z.array(QuestionStats.extend({ questionId: z.uuid() })),
});
export type PoolQuestionStats = z.infer<typeof PoolQuestionStats>;

/** `POST /questions/:id/stats/reset`: the instant the statistics now start from. */
export const StatsReset = z.object({ since: z.string() });
export type StatsReset = z.infer<typeof StatsReset>;
