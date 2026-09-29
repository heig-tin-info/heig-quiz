/**
 * `stats` route schemas: the item analysis of a question in its pool
 * (ADR-038, F-STAT-01…05).
 *
 * A question's statistics are the mean success rate `p` over the `n`
 * answers counted. The server applies the threshold: below
 * `QUESTION_STATS_MIN_N` answers (`@quiz/domain`) a question is absent from
 * the pool list and its own statistics are `null` — a smaller `n` never goes
 * on the wire. `p` is SIGNED: negative marking (ADR-026) can push it below
 * zero.
 */
import { z } from "zod";

export const ItemStats = z.object({
  n: z.number().int().nonnegative(),
  p: z.number(),
});
export type ItemStats = z.infer<typeof ItemStats>;

/** `GET /pools/:id/question-stats`: one entry per question that has enough answers. */
export const PoolQuestionStats = z.object({
  items: z.array(ItemStats.extend({ questionId: z.uuid() })),
});
export type PoolQuestionStats = z.infer<typeof PoolQuestionStats>;

/** `GET /questions/:id/stats`. `since` is the last reset, null when there was none. */
export const QuestionStats = z.object({
  since: z.string().nullable(),
  stats: ItemStats.nullable(),
});
export type QuestionStats = z.infer<typeof QuestionStats>;

/** `POST /questions/:id/stats/reset`: the instant the statistics now start from. */
export const StatsReset = z.object({ since: z.string() });
export type StatsReset = z.infer<typeof StatsReset>;
