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
 * KEPT attempt (ADR-025). A blank or skipped question counts 0; a question
 * the student never had on screen is left out (ADR-039) — except on the
 * attempts from before the dwell was measured (`display_tracked` false),
 * where it still counts 0; a student with no attempt is not counted.
 *
 * The TIME spent on a question (ADR-039) is its own series, with its own
 * threshold (`QUESTION_TIME_MIN_N`): the dwell of every answer of an EXAM
 * that was on screen, blanks and skips included, since the time on the
 * question is what the exam cost whatever the answer. It is shown on a
 * question that already qualifies on `n`, never alone. An exam has one
 * attempt, so there is no kept attempt to pick; a grading is not needed —
 * the time was spent whatever the points.
 *
 * Reads only: `questions` and `question_versions` (the `pool` module's),
 * `evaluation_items` and `evaluations` (the `evaluation` module's),
 * `attempts` and `answers` (the `live` module's) and `gradings` (the
 * `grading` module's), all by join. The reset, a write to `questions`,
 * lives in the `pool` module.
 */
import { and, eq, gt, gte, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";

import type { PoolQuestionStats } from "@quiz/contracts";
import { itemStats, shownItemStats, shownTimeStats, timeStats, type ScoredAnswer } from "@quiz/domain";

import { isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import {
  answers,
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
 * What makes an attempt count, whatever the series: a finished attempt of a
 * student account that is not a staff seat, started at or after the
 * question's `stats_since`.
 */
function countedAttempt(): SQL {
  return and(
    isNotNull(attempts.userId),
    inArray(attempts.state, ["submitted", "expired"]),
    isNotNull(attempts.startedAt),
    // The reset compares the START of the attempt: a grading moves on a
    // regrade or a late validation, a submission is null on an expiry.
    or(isNull(questions.statsSince), gte(attempts.startedAt, questions.statsSince)),
    sql`not ${isStaffAttempt}`,
  )!;
}

/**
 * Every question of the pool that has enough answers, with the instant its
 * statistics start from and its time; the others are absent.
 *
 * Three queries for the candidates and the evaluations they come from, two
 * for the kept attempts, one for the time. Every answer travels to the process; should a
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
    .leftJoin(
      answers,
      and(eq(answers.attemptId, gradings.attemptId), eq(answers.itemId, gradings.itemId)),
    )
    .where(
      and(
        eq(questions.poolId, poolId),
        inArray(evaluations.mode, ["exam", "exercise"]),
        countedAttempt(),
        // Not reached (ADR-039): a question never on screen says nothing of
        // its difficulty. Only a tracked attempt can tell.
        or(eq(attempts.displayTracked, false), isNotNull(answers.firstShownAt)),
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
  const scored = new Map<string, { since: Date | null; list: ScoredAnswer[] }>();
  for (const row of rows) {
    if (!kept.has(row.attemptId)) continue;
    const entry = scored.get(row.questionId) ?? { since: row.since, list: [] };
    entry.list.push({ points: row.points, maxPoints: row.maxPoints });
    scored.set(row.questionId, entry);
  }

  const dwells = await dwellsOf(db, poolId);
  const items: PoolQuestionStats["items"] = [];
  for (const [questionId, { since, list }] of scored) {
    const shown = shownItemStats(itemStats(list));
    if (!shown) continue;
    const time = shownTimeStats(timeStats(dwells.get(questionId) ?? []));
    items.push({
      questionId,
      since: isoOrNull(since),
      ...shown,
      time: time && {
        n: time.n,
        meanS: seconds(time.meanMs),
        medianS: seconds(time.medianMs),
        p25S: seconds(time.p25Ms),
        p75S: seconds(time.p75Ms),
      },
    });
  }
  return { items };
}

/** Whole seconds, as the contract carries them. */
function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

/** The timed exam answers of every question of the pool (ADR-039), by question. */
async function dwellsOf(db: Db, poolId: string): Promise<Map<string, number[]>> {
  const rows = await db
    .select({ questionId: questions.id, dwellMs: answers.dwellMs })
    .from(questions)
    .innerJoin(questionVersions, eq(questionVersions.questionId, questions.id))
    .innerJoin(evaluationItems, eq(evaluationItems.questionVersionId, questionVersions.id))
    .innerJoin(evaluations, eq(evaluations.id, evaluationItems.evaluationId))
    .innerJoin(answers, eq(answers.itemId, evaluationItems.id))
    .innerJoin(attempts, eq(attempts.id, answers.attemptId))
    .where(
      and(
        eq(questions.poolId, poolId),
        eq(evaluations.mode, "exam"),
        countedAttempt(),
        eq(attempts.displayTracked, true),
        isNotNull(answers.firstShownAt),
        gt(answers.dwellMs, 0),
      ),
    );
  const byQuestion = new Map<string, number[]>();
  for (const row of rows) {
    const list = byQuestion.get(row.questionId) ?? [];
    list.push(row.dwellMs);
    byQuestion.set(row.questionId, list);
  }
  return byQuestion;
}
