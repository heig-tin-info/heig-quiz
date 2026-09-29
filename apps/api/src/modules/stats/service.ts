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
 * The DISCRIMINATION index (ADR-041) reads the same counted answers, exams
 * only, and keeps an attempt only when every OTHER item of the exam has a
 * validated grading too: the rest of the test must be a grade, not a
 * proposal. Per exam, the corrected point-biserial of `@quiz/domain`; over
 * the exams, Fisher's z. Null when no exam qualifies.
 *
 * The DISTRACTORS of a multiple-choice question (ADR-042) read the same
 * counted answers too, narrowed to the versions that carry the latest
 * version's options: which option they picked, in whole percents, from ten
 * of them on.
 *
 * Reads only: `questions` and `question_versions` (the `pool` module's),
 * `evaluation_items` and `evaluations` (the `evaluation` module's),
 * `attempts` and `answers` (the `live` module's) and `gradings` (the
 * `grading` module's), all by join. The reset, a write to `questions`,
 * lives in the `pool` module.
 */
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";

import type { DistractorStats, PoolQuestionStats, TimeStats } from "@quiz/contracts";
import {
  discrimination,
  evaluationDiscrimination,
  itemStats,
  optionShares,
  QUESTION_STATS_MIN_N,
  sameAsLatest,
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
import { keptAttemptsOf, pairKey, type PairKey } from "../grading/service.js";
import { loadConfig, typeOf } from "../pool/config.js";

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
 * for the kept attempts, one for the time, two for the discrimination, two
 * for the distractors. Every answer travels to the process; should a
 * pool's history grow too large for that, the same filters pre-aggregate in
 * SQL (`count`, `avg(points / max_points)` by question) and only the
 * attempts of students who retook an exercise are fetched one by one.
 */
export async function poolQuestionStats(db: Db, poolId: string): Promise<PoolQuestionStats> {
  const rows = await db
    .select({
      questionId: questions.id,
      type: questions.type,
      versionId: questionVersions.id,
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
  const counted = rows.filter((row) => kept.has(row.attemptId));
  const scored = new Map<string, ScoredAnswer[]>();
  const sinceOf = new Map<string, Date | null>();
  for (const row of counted) {
    push(scored, row.questionId, row);
    sinceOf.set(row.questionId, row.since);
  }

  const dwells = await dwellsOf(db, poolId);
  const discriminations = await discriminationsOf(db, counted.filter((row) => row.mode === "exam"));
  const distractors = await distractorsOf(db, counted.filter((row) => row.type === DISTRACTOR_TYPE));
  const items: PoolQuestionStats["items"] = [];
  for (const [questionId, list] of scored) {
    const shown = shownItemStats(itemStats(list));
    if (!shown) continue;
    const time = shownTimeSpread(spread(dwells.get(questionId) ?? []));
    items.push({
      questionId,
      since: isoOrNull(sinceOf.get(questionId) ?? null),
      ...shown,
      time: time && inSeconds(time),
      discrimination: discrimination(discriminations.get(questionId) ?? []),
      // Absent for a type without the analysis; null below its threshold.
      ...(distractors.has(questionId) ? { distractors: distractors.get(questionId)! } : {}),
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
  for (const row of rows) push(byQuestion, row.questionId, row.dwellMs);
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
 * The per-exam samples of the discrimination index (ADR-041), by question.
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

  // Every validated grading of the counted attempts, by (attempt, item).
  const attemptIds = [...new Set(counted.map((a) => a.attemptId))];
  const graded = new Map<PairKey, ScoredAnswer>();
  const validated = await db
    .select({
      attemptId: gradings.attemptId,
      itemId: gradings.itemId,
      points: gradings.points,
      maxPoints: gradings.maxPoints,
    })
    .from(gradings)
    .where(and(inArray(gradings.attemptId, attemptIds), eq(gradings.state, "validated")));
  for (const g of validated) graded.set(pairKey(g.attemptId, g.itemId), g);

  // One sample per item of a pool question: its answers against the rest.
  const byItem = new Map<string, CountedExamAnswer[]>();
  for (const answer of counted) push(byItem, answer.itemId, answer);
  for (const [itemId, answers] of byItem) {
    const { questionId, evaluationId } = answers[0]!;
    const others = (itemsOf.get(evaluationId) ?? []).filter((id) => id !== itemId);
    const attempts: DiscriminationAttempt[] = [];
    for (const answer of answers) {
      const rest = restOfTest(graded, answer.attemptId, others);
      if (rest) attempts.push({ attemptId: answer.attemptId, item: answer, rest });
    }
    push(samples, questionId, evaluationDiscrimination(evaluationId, attempts, others.length));
  }
  return samples;
}

/** The points and the maximum of `others` on one attempt; null when one of them is not validated. */
function restOfTest(
  graded: ReadonlyMap<PairKey, ScoredAnswer>,
  attemptId: string,
  others: readonly string[],
): ScoredAnswer | null {
  const rest = { points: 0, maxPoints: 0 };
  for (const itemId of others) {
    const g = graded.get(pairKey(attemptId, itemId));
    if (!g) return null;
    rest.points += g.points;
    rest.maxPoints += g.maxPoints;
  }
  return rest;
}

/** The one type with a distractor analysis. */
const DISTRACTOR_TYPE = "mcq";

/** One counted answer of the success rate: which question, version, attempt and item. */
interface CountedAnswer {
  questionId: string;
  versionId: string;
  attemptId: string;
  itemId: string;
}

/** What an mcq config holds that this analysis reads. */
interface Choices {
  mode: "single" | "multiple";
  choices: { text: string; correct: boolean }[];
}

interface Version {
  id: string;
  choices: Choices | null;
}

/**
 * The distractor analysis (ADR-042) of every question of `counted`, which
 * are all of type {@link DISTRACTOR_TYPE}: an entry per question, null below
 * the threshold.
 *
 * `counted` are the answers the success rate counts — the same rows, kept
 * attempts and not-reached rule, exams and exercises alike —, narrowed here
 * to the published versions whose options (text and key, in order) are
 * the LATEST published version's, wherever they stand (`sameAsLatest`). The counting
 * is the type's own `aggregate` (ADR-033), through the registry, as the
 * results module calls it; the options are read through the one config
 * pipeline, as the poll module reads them. Below `QUESTION_STATS_MIN_N`
 * matching answers the entry is null HERE, and no answer is even read.
 */
async function distractorsOf(
  db: Db,
  counted: readonly CountedAnswer[],
): Promise<Map<string, DistractorStats | null>> {
  const result = new Map<string, DistractorStats | null>();
  const countedOf = new Map<string, CountedAnswer[]>();
  for (const answer of counted) push(countedOf, answer.questionId, answer);
  const questionIds = [...countedOf.keys()];
  if (questionIds.length === 0) return result;

  const versionsOf = new Map<string, Version[]>();
  const rows = await db
    .select({
      id: questionVersions.id,
      questionId: questionVersions.questionId,
      number: questionVersions.number,
      config: questionVersions.config,
      configVersion: questionVersions.configVersion,
    })
    .from(questionVersions)
    .where(and(inArray(questionVersions.questionId, questionIds), isNotNull(questionVersions.number)))
    .orderBy(asc(questionVersions.number));
  for (const row of rows) {
    push(versionsOf, row.questionId, { id: row.id, choices: choicesOf(row) });
  }

  // Per question, the answers given to the versions sharing the latest's options.
  const matched = new Map<string, { latest: Choices; answers: CountedAnswer[] }>();
  for (const questionId of questionIds) {
    const same = sameAsLatest(versionsOf.get(questionId) ?? [], (v) => v.choices && keyOf(v.choices));
    const ids = new Set(same.map((v) => v.id));
    const matching = countedOf.get(questionId)!.filter((a) => ids.has(a.versionId));
    // Below the threshold no answer is read: `optionShares` would refuse it anyway.
    if (matching.length < QUESTION_STATS_MIN_N) result.set(questionId, null);
    else matched.set(questionId, { latest: same.at(-1)!.choices!, answers: matching });
  }
  if (matched.size === 0) return result;

  const wanted = [...matched.values()].flatMap((r) => r.answers);
  const payloadOf = new Map<PairKey, unknown>();
  const stored = await db
    .select({
      attemptId: answers.attemptId,
      itemId: answers.itemId,
      payload: answers.payload,
      skipped: answers.skipped,
    })
    .from(answers)
    .where(
      and(
        inArray(answers.attemptId, [...new Set(wanted.map((a) => a.attemptId))]),
        inArray(answers.itemId, [...new Set(wanted.map((a) => a.itemId))]),
      ),
    );
  // A skipped question counts as no answer, as in the class debrief.
  for (const a of stored) if (!a.skipped) payloadOf.set(pairKey(a.attemptId, a.itemId), a.payload);

  const type = typeOf(DISTRACTOR_TYPE);
  const answered = (payload: unknown) => {
    const parsed = type.answerSchema.safeParse(payload);
    return parsed.success && type.isAnswered(parsed.data);
  };
  for (const [questionId, { latest, answers: given }] of matched) {
    const payloads = given.map((a) => payloadOf.get(pairKey(a.attemptId, a.itemId)) ?? null);
    const tally = new Map(
      (type.aggregate?.({ answers: payloads, details: [] }).distribution ?? []).map((e) => [e.key, e.count]),
    );
    const counts = latest.choices.map((_, index) => tally.get(String(index)) ?? 0);
    const none = payloads.filter((p) => !answered(p)).length;
    const shares = optionShares(counts, none, given.length)!;
    result.set(questionId, {
      n: given.length,
      multiple: latest.mode === "multiple",
      options: latest.choices.map((choice, index) => ({
        text: choice.text,
        correct: choice.correct,
        share: shares.options[index]!,
      })),
      none: shares.none,
    });
  }
  return result;
}

/** A version's options, or null when its config cannot be read. */
function choicesOf(row: { config: unknown; configVersion: number }): Choices | null {
  try {
    const { mode, choices } = loadConfig(DISTRACTOR_TYPE, row) as Choices;
    return { mode, choices: choices.map(({ text, correct }) => ({ text, correct })) };
  } catch {
    return null;
  }
}

/** Two versions have the same options when their texts and their key are the same, in order. */
function keyOf(choices: Choices): string {
  return JSON.stringify(choices.choices.map((c) => [c.text, c.correct]));
}

/** Appends `value` to the list of `key`, the one grouping idiom of this module. */
function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
