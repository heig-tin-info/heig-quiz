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
 * One question's statistics, where they start (the last reset, null when
 * there was none), and its time — null below its own threshold.
 */
export const QuestionStats = ItemStats.extend({
  since: z.string().nullable(),
  time: TimeStats.nullable(),
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
