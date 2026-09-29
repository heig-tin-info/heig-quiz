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
 * The DISCRIMINATION index (ADR-040) reads the same counted answers, exams
 * only, and keeps an attempt only when every OTHER item of the exam has a
 * validated grading too: the rest of the test must be a grade, not a
 * proposal. Per exam, the corrected point-biserial of `@quiz/domain`; over
 * the exams, Fisher's z. Null when no exam qualifies.
 *
 * Reads only: `questions` and `question_versions` (the `pool` module's),
 * `evaluation_items` and `evaluations` (the `evaluation` module's),
 * `attempts` and `answers` (the `live` module's) and `gradings` (the
 * `grading` module's), all by join. The reset, a write to `questions`,
 * lives in the `pool` module.
 */
import { and, eq, gt, gte, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";

import type { PoolQuestionStats, TimeStats } from "@quiz/contracts";
import {
  discrimination,
  evaluationDiscrimination,
  itemStats,
  shownItemStats,
  shownTimeSpread,
  spread,
  type DiscriminationAttempt,
  type DiscriminationSample,
  type ScoredAnswer,
  type Spread,
} from "@quiz/domain";

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
 * for the kept attempts, one for the time, two for the discrimination. Every answer travels to the process; should a
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
      mode: evaluations.mode,
      itemId: evaluationItems.id,
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
  const counted = rows.filter((row) => kept.has(row.attemptId));
  for (const row of counted) {
    const entry = scored.get(row.questionId) ?? { since: row.since, list: [] };
    entry.list.push({ points: row.points, maxPoints: row.maxPoints });
    scored.set(row.questionId, entry);
  }

  const dwells = await dwellsOf(db, poolId);
  const discriminations = await discriminationsOf(db, counted.filter((row) => row.mode === "exam"));
  const items: PoolQuestionStats["items"] = [];
  for (const [questionId, { since, list }] of scored) {
    const shown = shownItemStats(itemStats(list));
    if (!shown) continue;
    const time = shownTimeSpread(spread(dwells.get(questionId) ?? []));
    items.push({
      questionId,
      since: isoOrNull(since),
      ...shown,
      time: time && inSeconds(time),
      discrimination: discrimination(discriminations.get(questionId) ?? []),
    });
  }
  return { items };
}

/** A spread of milliseconds in whole seconds, as the contract carries it. */
function inSeconds(ms: Spread): TimeStats {
  const s = (v: number) => Math.round(v / 1000);
  return { n: ms.n, meanS: s(ms.mean), medianS: s(ms.median), p25S: s(ms.p25), p75S: s(ms.p75) };
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
        // A positive dwell: the question was on screen (the series' one filter).
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

/** One counted exam answer to a question: its item, its attempt and its points. */
interface CountedExamAnswer extends ScoredAnswer {
  questionId: string;
  evaluationId: string;
  itemId: string;
  attemptId: string;
}

/**
 * The per-exam samples of the discrimination index (ADR-040), by question.
 *
 * `counted` are the answers the success rate counts, of exams only: the
 * population rules live in {@link countedAttempt}, the not-reached rule and
 * the kept filter, once. An attempt enters an exam's sample only when every
 * other item worth something has a VALIDATED grading on it; the rest of the
 * test is the ratio of its points to its maximum, over those other items.
 */
async function discriminationsOf(
  db: Db,
  counted: readonly CountedExamAnswer[],
): Promise<Map<string, (DiscriminationSample | null)[]>> {
  const samples = new Map<string, (DiscriminationSample | null)[]>();
  const evaluationIds = [...new Set(counted.map((a) => a.evaluationId))];
  if (evaluationIds.length === 0) return samples;

  // The items that make up each exam's total: those worth something.
  const itemsOf = new Map<string, string[]>();
  const items = await db
    .select({ id: evaluationItems.id, evaluationId: evaluationItems.evaluationId })
    .from(evaluationItems)
    .where(and(inArray(evaluationItems.evaluationId, evaluationIds), gt(evaluationItems.points, 0)));
  for (const item of items) push(itemsOf, item.evaluationId, item.id);

  // Every validated grading of those exams, by attempt then item.
  const graded = new Map<string, Map<string, ScoredAnswer>>();
  const validated = await db
    .select({
      attemptId: gradings.attemptId,
      itemId: gradings.itemId,
      points: gradings.points,
      maxPoints: gradings.maxPoints,
    })
    .from(gradings)
    .innerJoin(evaluationItems, eq(evaluationItems.id, gradings.itemId))
    .where(and(inArray(evaluationItems.evaluationId, evaluationIds), eq(gradings.state, "validated")));
  for (const g of validated) {
    const byItem = graded.get(g.attemptId) ?? new Map<string, ScoredAnswer>();
    byItem.set(g.itemId, { points: g.points, maxPoints: g.maxPoints });
    graded.set(g.attemptId, byItem);
  }

  // One sample per item of a pool question: its answers against the rest.
  const byItem = new Map<string, CountedExamAnswer[]>();
  for (const answer of counted) push(byItem, answer.itemId, answer);
  for (const [itemId, answers] of byItem) {
    const { questionId, evaluationId } = answers[0]!;
    const others = (itemsOf.get(evaluationId) ?? []).filter((id) => id !== itemId);
    const attempts: DiscriminationAttempt[] = [];
    for (const answer of answers) {
      const rest = restOfTest(graded.get(answer.attemptId), others);
      if (rest) attempts.push({ item: answer, rest });
    }
    push(samples, questionId, evaluationDiscrimination(attempts, others.length));
  }
  return samples;
}

/** The points and the maximum of `others` on one attempt; null when one of them is not validated. */
function restOfTest(graded: Map<string, ScoredAnswer> | undefined, others: readonly string[]): ScoredAnswer | null {
  const rest = { points: 0, maxPoints: 0 };
  for (const id of others) {
    const g = graded?.get(id);
    if (!g) return null;
    rest.points += g.points;
    rest.maxPoints += g.maxPoints;
  }
  return rest;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
