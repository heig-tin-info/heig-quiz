/**
 * The `stats` module: the item analysis of a question in its pool (ADR-038,
 * F-STAT-01…05).
 *
 * One number per QUESTION, every version pooled: the mean success rate `p`
 * of the answers counted, with their number `n`, shown only from
 * `QUESTION_STATS_MIN_N` answers on — the threshold is applied HERE, so a
 * smaller `n` never leaves the server. An answer is counted when it is the
 * validated grading of a question's item, in an EXAM (never an exercise,
 * ADR-038 §2), on a finished attempt of a student account that is not a
 * staff seat (ADR-018), started at or after the question's `stats_since`.
 * A blank or skipped question counts 0; a question the student never had on
 * screen is left out (ADR-039) — except on the attempts from before the
 * dwell was measured (`display_tracked` false), where it still counts 0; a
 * student with no attempt is not counted.
 *
 * The TIME spent on a question (ADR-039) is its own series, with its own
 * threshold (`QUESTION_TIME_MIN_N`): the dwell of every answer of an EXAM
 * that was on screen, blanks and skips included, since the time on the
 * question is what the exam cost whatever the answer. It is shown on a
 * question that already qualifies on `n`, never alone. A grading is not
 * needed — the time was spent whatever the points.
 *
 * The DISCRIMINATION index (ADR-042) reads the same counted answers and
 * keeps an attempt only when every OTHER item of the exam has a validated
 * grading too: the rest of the test must be a grade, not a proposal. Per
 * exam, the corrected point-biserial of `@quiz/domain`; over the exams,
 * Fisher's z. Null when no exam qualifies.
 *
 * The DISTRACTORS of a multiple-choice question (ADR-043) read the same
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
  sameAsLatest,
  shownItemStats,
  shownTimeSpread,
  spread,
  type DiscriminationAttempt,
  type DiscriminationSample,
  type ScoredAnswer,
  type Spread,
} from "@quiz/domain";
import { drawnApart, type Parameters } from "@quiz/domain/parameters";

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
import { pairKey, type PairKey } from "../grading/service.js";
import { answeredBy } from "../live/service.js";
import { tryLoadConfig, typeOf } from "../pool/config.js";
import { parametersOf } from "../pool/service.js";

/**
 * What makes an attempt count, whatever the series: a finished attempt of an
 * exam, by a student account that is not a staff seat, started at or after
 * the question's `stats_since`.
 */
function countedAttempt(): SQL {
  return and(
    eq(evaluations.mode, "exam"),
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
 * One query for the counted answers, one for the time, two for the
 * discrimination, one for the versions of the multiple-choice questions
 * (their answers come with the counted ones). Every answer travels to the
 * process; should a pool's history grow too large for that, the same
 * filters pre-aggregate in SQL (`count`, `avg(points / max_points)` by
 * question).
 *
 * `questionIds` narrows to those questions of the pool (the similar
 * questions of ADR-022's addendum of 2026-10-01): each keeps exactly the
 * figures the whole pool would give it, its discrimination included — the
 * rest of an exam is read by attempt, not by pool.
 */
export async function poolQuestionStats(
  db: Db,
  poolId: string,
  questionIds?: readonly string[],
): Promise<PoolQuestionStats> {
  const ofPool = questionsOf(poolId, questionIds);
  const rows = await db
    .select({
      questionId: questions.id,
      type: questions.type,
      versionId: questionVersions.id,
      since: questions.statsSince,
      attemptId: attempts.id,
      evaluationId: evaluations.id,
      itemId: evaluationItems.id,
      points: gradings.points,
      maxPoints: gradings.maxPoints,
      // What the student picked, for the distractors (ADR-043): mcq only, so
      // no other type's payload — a program, an essay — travels for nothing.
      skipped: answers.skipped,
      payload: sql<unknown>`case when ${questions.type} = ${DISTRACTOR_TYPE} then ${answers.payload} end`,
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
        ofPool,
        countedAttempt(),
        // Not reached (ADR-039): a question never on screen says nothing of
        // its difficulty. Only a tracked attempt can tell.
        or(eq(attempts.displayTracked, false), isNotNull(answers.firstShownAt)),
      ),
    );

  const scored = new Map<string, ScoredAnswer[]>();
  const sinceOf = new Map<string, Date | null>();
  for (const row of rows) {
    push(scored, row.questionId, row);
    sinceOf.set(row.questionId, row.since);
  }

  const dwells = await dwellsOf(db, ofPool);
  const discriminations = await discriminationsOf(db, rows);
  const distractors = await distractorsOf(db, rows.filter((row) => row.type === DISTRACTOR_TYPE));
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

/** The questions of the pool, or those of `ids` in it. */
function questionsOf(poolId: string, ids?: readonly string[]): SQL {
  const inPool = eq(questions.poolId, poolId);
  return ids ? and(inPool, inArray(questions.id, [...ids]))! : inPool;
}

/** The timed exam answers of the questions `ofPool` selects (ADR-039), by question. */
async function dwellsOf(db: Db, ofPool: SQL): Promise<Map<string, number[]>> {
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
        ofPool,
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
 * The per-exam samples of the discrimination index (ADR-042), by question.
 *
 * `counted` are the answers the success rate counts: the population rules
 * live in {@link countedAttempt} and the not-reached rule, once. An attempt
 * enters an exam's sample only when every other item worth something has a
 * VALIDATED grading on it; the rest of the test is the ratio of its points
 * to its maximum, over those other items.
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

/** One counted answer of the success rate, with what it stored: its question, version and payload. */
interface CountedAnswer {
  questionId: string;
  versionId: string;
  skipped: boolean | null;
  payload: unknown;
}

/** What an mcq config holds that this analysis reads. */
interface Choices {
  prompt: string;
  mode: "single" | "multiple";
  choices: { text: string; correct: boolean }[];
}

/**
 * The distractor analysis (ADR-043) of every question of `counted`, which
 * are all of type {@link DISTRACTOR_TYPE}: an entry per question, null below
 * the threshold.
 *
 * `counted` are the answers the success rate counts, with the same
 * population and not-reached rule, narrowed here to the published versions
 * whose options (text and key, in order) are the LATEST published
 * version's, wherever they stand (`sameAsLatest`).
 * The counting is the type's own `aggregate` (ADR-033), through the
 * registry, and "picked nothing" is `answeredBy`, both as the class debrief
 * of the results module reads them; the options are read through the one
 * config pipeline, as the poll module reads them.
 */
async function distractorsOf(
  db: Db,
  counted: readonly CountedAnswer[],
): Promise<Map<string, DistractorStats | null>> {
  const result = new Map<string, DistractorStats | null>();
  const countedOf = new Map<string, CountedAnswer[]>();
  for (const answer of counted) push(countedOf, answer.questionId, answer);
  if (countedOf.size === 0) return result;

  const versionsOf = new Map<string, { id: string; choices: Choices | null; params: Parameters | null }[]>();
  const rows = await db
    .select({
      id: questionVersions.id,
      questionId: questionVersions.questionId,
      config: questionVersions.config,
      configVersion: questionVersions.configVersion,
      variables: questionVersions.variables,
    })
    .from(questionVersions)
    .where(and(inArray(questionVersions.questionId, [...countedOf.keys()]), isNotNull(questionVersions.number)))
    .orderBy(asc(questionVersions.number));
  for (const row of rows) {
    // A version whose config cannot be read matches nothing. A parameterized
    // mcq is read as its TEMPLATE on purpose: its options are grouped by
    // their template text (ADR-056 §9).
    const loaded = tryLoadConfig(DISTRACTOR_TYPE, row, { template: true });
    push(versionsOf, row.questionId, {
      id: row.id,
      choices: loaded.ok ? (loaded.config as Choices) : null,
      params: parametersOf(row),
    });
  }

  const type = typeOf(DISTRACTOR_TYPE);
  const answered = answeredBy({ question: { type: DISTRACTOR_TYPE } });
  for (const [questionId, given] of countedOf) {
    const same = sameAsLatest(versionsOf.get(questionId) ?? [], (v) => v.choices && keyOf(v.choices));
    const latest = same.at(-1)?.choices;
    const drawn = drawnOptions(latest, same.at(-1)?.params ?? null);
    const ids = new Set(same.map((v) => v.id));
    // A skipped question is no answer, whatever it stored: the class debrief's rule.
    const payloads = given
      .filter((a) => ids.has(a.versionId))
      .map((a) => (a.skipped || !answered(a.payload) ? null : a.payload));
    const tally = new Map(
      (type.aggregate?.({ answers: payloads, details: [] }).distribution ?? []).map((e) => [e.key, e.count]),
    );
    const counts = (latest?.choices ?? []).map((_, index) => tally.get(String(index)) ?? 0);
    const shares = latest ? optionShares(counts, payloads.filter((p) => p === null).length, payloads.length) : null;
    result.set(
      questionId,
      latest && shares
        ? {
            n: payloads.length,
            // Any matching version that let several choices be ticked lets the shares pass 100.
            multiple: same.some((v) => v.choices!.mode === "multiple"),
            options: latest.choices.map(({ text, correct }, i) => ({
              text,
              correct,
              share: shares.options[i]!,
              ...(drawn[i] ? { drawn: true } : {}),
            })),
            none: shares.none,
          }
        : null,
    );
  }
  return result;
}

/**
 * Which options of a parameterized mcq show a value drawn for them alone
 * (ADR-056 §9): a `uniform()` or `choice()` distractor, a different number
 * for each student, against the statement and the correct choices. A
 * formula distractor (`[[sqrt(h/g)]]`) is not one. All false for a static
 * question.
 */
function drawnOptions(choices: Choices | null | undefined, params: Parameters | null): boolean[] {
  if (!choices || params === null) return [];
  const shared = [choices.prompt, ...choices.choices.filter((c) => c.correct).map((c) => c.text)];
  return choices.choices.map((c) => !c.correct && drawnApart(c.text, shared, params));
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
