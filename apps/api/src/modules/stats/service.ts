/**
 * The `stats` module: the item analysis of a question in its pool (ADR-038,
 * F-STAT-01…05).
 *
 * One number per QUESTION, every version pooled: the mean success rate `p`
 * of the answers counted, with their number `n`, shown only from
 * `QUESTION_STATS_MIN_N` answers on — the threshold is applied HERE, so a
 * smaller `n` never leaves the server. An answer is counted when it is the
 * validated grading of a question's item, in an exam or an exercise, on a
 * finished attempt of a student account that is not a staff seat (ADR-018),
 * started at or after the question's `stats_since`, and on the student's
 * KEPT attempt (ADR-025). A blank, skipped or unanswered question counts 0;
 * a student with no attempt is not counted.
 *
 * Reads only: `questions` and `question_versions` (the `pool` module's),
 * `evaluation_items` and `evaluations` (the `evaluation` module's),
 * `attempts` (the `live` module's) and `gradings` (the `grading` module's),
 * all by join. The reset, a write to `questions`, lives in the `pool` module.
 */
import { and, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

import type { PoolQuestionStats } from "@quiz/contracts";
import { itemStats, shownItemStats, type ScoredAnswer } from "@quiz/domain";

import { isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import {
  attempts,
  evaluationItems,
  evaluations,
  gradings,
  questionVersions,
  questions,
} from "../../db/schema.js";
import { isStaffAttempt } from "../evaluation/service.js";
import { keptAttemptsOf } from "../grading/service.js";

/**
 * Every question of the pool that has enough answers, with the instant its
 * statistics start from; the others are absent.
 *
 * Three queries for the candidates and the evaluations they come from, two
 * for the kept attempts. Every answer travels to the process; should a
 * pool's history grow too large for that, the same filters pre-aggregate in
 * SQL (`count`, `avg(points / max_points)` by question) and only the
 * attempts of students who retook an exercise are fetched one by one.
 */
export async function poolQuestionStats(db: Db, poolId: string): Promise<PoolQuestionStats> {
  const rows = await db
    .select({
      questionId: questions.id,
      since: questions.statsSince,
      attemptId: attempts.id,
      evaluationId: evaluations.id,
      points: gradings.points,
      maxPoints: gradings.maxPoints,
    })
    .from(questions)
    .innerJoin(questionVersions, eq(questionVersions.questionId, questions.id))
    .innerJoin(evaluationItems, eq(evaluationItems.questionVersionId, questionVersions.id))
    .innerJoin(evaluations, eq(evaluations.id, evaluationItems.evaluationId))
    .innerJoin(
      gradings,
      and(eq(gradings.itemId, evaluationItems.id), eq(gradings.state, "validated")),
    )
    .innerJoin(attempts, eq(attempts.id, gradings.attemptId))
    .where(
      and(
        eq(questions.poolId, poolId),
        inArray(evaluations.mode, ["exam", "exercise"]),
        isNotNull(attempts.userId),
        inArray(attempts.state, ["submitted", "expired"]),
        isNotNull(attempts.startedAt),
        // The reset compares the START of the attempt: a grading moves on a
        // regrade or a late validation, a submission is null on an expiry.
        or(isNull(questions.statsSince), gte(attempts.startedAt, questions.statsSince)),
        sql`not ${isStaffAttempt}`,
      ),
    );

  const evaluationIds = [...new Set(rows.map((r) => r.evaluationId))];
  const kept = new Set<string>();
  if (evaluationIds.length > 0) {
    const found = await db.select().from(evaluations).where(inArray(evaluations.id, evaluationIds));
    for (const byUser of (await keptAttemptsOf(db, found)).values()) {
      for (const attempt of byUser.values()) kept.add(attempt.id);
    }
  }

  // Only the kept attempt counts — never a fallback to another attempt when
  // the kept one's grading of the item is still a proposal.
  const answers = new Map<string, { since: Date | null; list: ScoredAnswer[] }>();
  for (const row of rows) {
    if (!kept.has(row.attemptId)) continue;
    const entry = answers.get(row.questionId) ?? { since: row.since, list: [] };
    entry.list.push({ points: row.points, maxPoints: row.maxPoints });
    answers.set(row.questionId, entry);
  }

  const items: PoolQuestionStats["items"] = [];
  for (const [questionId, { since, list }] of answers) {
    const shown = shownItemStats(itemStats(list));
    if (shown) items.push({ questionId, since: isoOrNull(since), ...shown });
  }
  return { items };
}
