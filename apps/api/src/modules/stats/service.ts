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
 * started at or after the question's `stats_since`, and — on an exercise
 * with retakes — on the student's KEPT attempt (ADR-025). A blank, skipped
 * or unanswered question counts 0; a student with no attempt is not counted.
 *
 * Reads only: `questions` and `question_versions` (the `pool` module's),
 * `evaluation_items` and `evaluations` (the `evaluation` module's),
 * `attempts` (the `live` module's) and `gradings` (the `grading` module's),
 * all by join. The reset, a write to `questions`, lives in the `pool` module.
 */
import { and, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";

import type { PoolQuestionStats, QuestionStats } from "@quiz/contracts";
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
import { keptAttemptIdsOf } from "../grading/service.js";

type QuestionRecord = typeof questions.$inferSelect;

/** Another attempt of the same student on the same evaluation: the kept rule decides. */
const isRetaken = sql`exists (select 1 from ${attempts} as other where other.evaluation_id = ${attempts.evaluationId} and other.user_id = ${attempts.userId} and other.id <> ${attempts.id})`;

/**
 * The counted answers of the questions `scope` selects, by question id.
 *
 * One query for the candidates, then — only when some student holds several
 * attempts — one for the evaluations concerned and two for their kept
 * attempts. Every answer travels to the process; should a pool's history
 * grow too large for that, the same filters pre-aggregate in SQL (`count`,
 * `avg(points / max_points)` grouped by question and attempt kind) and only
 * the retaken rows are fetched one by one.
 */
async function countedAnswers(db: Db, scope: SQL): Promise<Map<string, ScoredAnswer[]>> {
  const rows = await db
    .select({
      questionId: questions.id,
      attemptId: attempts.id,
      evaluationId: evaluations.id,
      points: gradings.points,
      maxPoints: gradings.maxPoints,
      retaken: sql<boolean>`${isRetaken}`,
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
        scope,
        inArray(evaluations.mode, ["exam", "exercise"]),
        isNotNull(attempts.userId),
        inArray(attempts.state, ["submitted", "expired"]),
        isNotNull(attempts.startedAt),
        // The reset compares the START of the attempt: a grading moves on a
        // regrade or a late validation, a submission is null on an expiry.
        or(isNull(questions.statsSince), sql`${attempts.startedAt} >= ${questions.statsSince}`),
        gt(gradings.maxPoints, 0),
        sql`not ${isStaffAttempt}`,
      ),
    );

  const retakenIds = [...new Set(rows.filter((r) => r.retaken).map((r) => r.evaluationId))];
  const kept =
    retakenIds.length === 0
      ? new Set<string>()
      : await keptAttemptIdsOf(
          db,
          await db.select().from(evaluations).where(inArray(evaluations.id, retakenIds)),
        );

  const out = new Map<string, ScoredAnswer[]>();
  for (const row of rows) {
    // A retaken attempt counts only if it is the kept one — never a fallback
    // to another attempt when the kept one's grading is still a proposal.
    if (row.retaken && !kept.has(row.attemptId)) continue;
    const list = out.get(row.questionId) ?? [];
    list.push({ points: row.points, maxPoints: row.maxPoints });
    out.set(row.questionId, list);
  }
  return out;
}

/** Every question of the pool that has enough answers; the others are absent. */
export async function poolQuestionStats(db: Db, poolId: string): Promise<PoolQuestionStats> {
  const answers = await countedAnswers(db, eq(questions.poolId, poolId));
  const items: PoolQuestionStats["items"] = [];
  for (const [questionId, list] of answers) {
    const shown = shownItemStats(itemStats(list));
    if (shown) items.push({ questionId, ...shown });
  }
  return { items };
}

/** One question's statistics, null below the threshold, and where they start. */
export async function questionStats(db: Db, question: QuestionRecord): Promise<QuestionStats> {
  const answers = await countedAnswers(db, eq(questions.id, question.id));
  return {
    since: isoOrNull(question.statsSince),
    stats: shownItemStats(itemStats(answers.get(question.id) ?? [])),
  };
}
