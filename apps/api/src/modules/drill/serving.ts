/**
 * What serving a drill card takes, shared by the daily session
 * (`review.ts`, ADR-041) and targeted revision (`revision.ts`, ADR-115):
 * which cards are reachable at all, whether their key may reach their
 * student, the question as it stands now, the instance and view one serve
 * shows, and the grading of an answer to it.
 *
 * What holds by construction, for both callers:
 *   - a card is reached only while it is ACTIVE ({@link activeCards}): its
 *     classroom has the drill on and is not archived (06, question 28 (g)),
 *     the student still holds a student seat there and has not opted out,
 *     and the question is not deleted;
 *   - it is served only when its evaluation lets the key reach the student
 *     ({@link keyOpen}): a review, a round's answer alike, ends on the key;
 *   - the question reaches the student through `studentViewOf` only, its key
 *     through `studentSolutionViewOf` only, after the answer ({@link
 *     gradeServed}; invariant 4).
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, type SQL } from "drizzle-orm";

import type { AnswerCoordinates } from "@quiz/contracts";
import type { StudentView } from "@quiz/core/server";
import { drillCorrectness, isDrillEligible } from "@quiz/domain";
import { ParameterError } from "@quiz/domain/parameters";

import type { StoredInstance } from "../../db/columns.js";
import {
  attempts,
  classrooms,
  courses,
  drillCards,
  drillRevisionAnswers,
  drillRevisionRounds,
  enrollments,
  evaluations,
  questions,
} from "../../db/schema.js";
import { gradeDefaults, type DbOrTx, type EvaluationRecord } from "../evaluation/service.js";
import { refusalClass, type Refusal } from "../http.js";
import { answerFromStudent, studentSolutionViewOf, studentViewOf } from "../live/service.js";
import { instanceOf, InstanceMismatch, loadConfig, typeOf, type VersionContent } from "../pool/service.js";
import { keyShownTo } from "../results/service.js";
import { currentVersions, drillGradeContext } from "./lifecycle.js";

/** Everything this module refuses, by code: its status and, where it has one, its message. */
const REFUSALS = {
  // A card or a round that is not the caller's, not active, or out of
  // reach today: indistinguishable from a missing one.
  not_found: [404],
  // An answer to a card that was not served (or already answered).
  drill_not_served: [409, "serve the card before answering it"],
  // A round's card with no pass left: answered right, or twice.
  revision_answered: [409, "this card has no pass left in the round"],
  // The answer does not satisfy the type's own schema.
  answer_invalid: [422],
} satisfies Record<string, Refusal>;

export class DrillError extends refusalClass("DrillError", REFUSALS) {}

/** The cards the drill may reach, with what a session or a round needs to know of them. */
export function activeCards(db: DbOrTx, where: SQL | undefined) {
  return db
    .select({
      card: drillCards,
      type: questions.type,
      courseCode: courses.code,
      courseName: courses.name,
    })
    .from(drillCards)
    .innerJoin(
      classrooms,
      and(
        eq(classrooms.id, drillCards.classroomId),
        isNotNull(classrooms.drillEnabledAt),
        isNull(classrooms.archivedAt),
      ),
    )
    .innerJoin(courses, eq(courses.id, classrooms.courseId))
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.classroomId, drillCards.classroomId),
        eq(enrollments.userId, drillCards.userId),
        eq(enrollments.staff, false),
        isNull(enrollments.drillOptedOutAt),
      ),
    )
    .innerJoin(questions, and(eq(questions.id, drillCards.questionId), isNull(questions.deletedAt)))
    .where(where);
}

export type ActiveRow = Awaited<ReturnType<typeof activeCards>>[number];
export type Day = { start: Date; end: Date };

/** The caller's own card, while it is active; the 404 of a missing card otherwise. */
export async function ownActiveCard(db: DbOrTx, userId: string, cardId: string): Promise<ActiveRow> {
  const [row] = await activeCards(db, and(eq(drillCards.id, cardId), eq(drillCards.userId, userId)));
  if (!row) throw new DrillError("not_found");
  return row;
}

/** A card, as far as its key's release is concerned: where it was met and whose it is. */
type KeyedCard = { evaluationId: string; userId: string };

/**
 * Whether the card's evaluation lets its key reach its student now (ADR-041
 * §13) — a review always ends on the key:
 *   - an exam's, once its results are released: a withdrawn release
 *     suspends its cards until the next one;
 *   - an exercise's, once its own feedback policy shows the key to the
 *     student's latest attempt (`results.keyShownTo`, the rule of the
 *     feedback page): at the hand-in under immediate feedback with the key,
 *     at the release under `on_release`, never when the key is not shown —
 *     and, since ADR-050, as soon as the teacher publishes the correction of
 *     the running exercise, which that rule counts as the release.
 */
function keyReleased(evaluation: EvaluationRecord, latestAttemptState: string | undefined): boolean {
  if (evaluation.mode === "exam") return evaluation.releasedAt !== null;
  if (evaluation.mode !== "exercise") return false;
  return latestAttemptState !== undefined && keyShownTo(evaluation, latestAttemptState);
}

/**
 * The evaluations the cards were met in and the latest attempt of each
 * student, two queries whatever the number of cards, and from them whether a
 * card's key is released ({@link keyReleased}); false when its evaluation is
 * gone.
 */
async function loadKeys(db: DbOrTx, cards: readonly KeyedCard[]) {
  const evaluationIds = [...new Set(cards.map((c) => c.evaluationId))];
  const userIds = [...new Set(cards.map((c) => c.userId))];
  if (evaluationIds.length === 0) return { evaluations: new Map<string, EvaluationRecord>(), open: () => false };
  const [found, latest] = await Promise.all([
    db.select().from(evaluations).where(inArray(evaluations.id, evaluationIds)),
    db
      .selectDistinctOn([attempts.evaluationId, attempts.userId], {
        evaluationId: attempts.evaluationId,
        userId: attempts.userId,
        state: attempts.state,
      })
      .from(attempts)
      .where(and(inArray(attempts.evaluationId, evaluationIds), inArray(attempts.userId, userIds)))
      .orderBy(attempts.evaluationId, attempts.userId, desc(attempts.attemptNumber)),
  ]);
  const byEvaluation = new Map(found.map((e) => [e.id, e]));
  const state = new Map(latest.map((a) => [`${a.evaluationId}:${a.userId}`, a.state]));
  return {
    evaluations: byEvaluation,
    open: (card: KeyedCard) => {
      const evaluation = byEvaluation.get(card.evaluationId);
      return evaluation !== undefined && keyReleased(evaluation, state.get(`${card.evaluationId}:${card.userId}`));
    },
  };
}

/**
 * The one place that says whether cards may show their key now: the drill
 * serves only those (a suspended card is not served), and the teacher's
 * mastery counts only those, so the two agree (ADR-081 sixth addendum §9).
 */
export async function keyOpen(db: DbOrTx, cards: readonly KeyedCard[]): Promise<(card: KeyedCard) => boolean> {
  return (await loadKeys(db, cards)).open;
}

/**
 * What serving a set of cards needs, loaded in a bounded number of queries
 * whatever their number: the question versions as they stand now, and the
 * evaluations and keys ({@link loadKeys}).
 */
export async function loadContext(db: DbOrTx, rows: readonly ActiveRow[]) {
  const [versions, keys] = await Promise.all([
    rows.length === 0 ? new Map() : currentVersions(db, [...new Set(rows.map((r) => r.card.questionId))]),
    loadKeys(db, rows.map((r) => r.card)),
  ]);
  return { versions, ...keys };
}
type Context = Awaited<ReturnType<typeof loadContext>>;

/**
 * The question of a card as it stands now, the settings of the evaluation
 * where it was met first (06, question 28 (e)), and whether the card may be
 * served ({@link keyReleased}). Whether the question can be drilled at all
 * was decided when the card was created (ADR-041 §3). Null when the
 * question has no published version or the evaluation is gone.
 */
export function questionOf(row: ActiveRow, context: Context) {
  const version = context.versions.get(row.card.questionId);
  const evaluation = context.evaluations.get(row.card.evaluationId);
  if (!version || !evaluation) return null;
  return {
    version,
    defaults: gradeDefaults(evaluation),
    open: context.open(row.card),
  };
}
export type ServedQuestion = NonNullable<ReturnType<typeof questionOf>>;

/**
 * The card's question, when its key may reach the student; the 404 of a
 * missing card otherwise. A card held back keeps its history.
 */
export async function openQuestionOf(db: DbOrTx, row: ActiveRow): Promise<ServedQuestion> {
  const question = questionOf(row, await loadContext(db, [row]));
  if (!question?.open) throw new DrillError("not_found");
  return question;
}

/**
 * The instance one serve shows (ADR-056 §5): the values stored when the card
 * was served, replayed when the question was republished since under the
 * same names, drawn again from the serve's seed when the names changed or
 * the replay fails on the new version's rows (§7: never an error for the
 * student) — the card is the item, so the stream is the card's. Static: the
 * version.
 */
export function reviewInstance(row: ActiveRow, version: VersionContent, seed: number, stored: StoredInstance | null) {
  const at = { seed, itemId: row.card.id };
  try {
    return instanceOf(row.type, version, { ...at, stored });
  } catch (error) {
    if (!(error instanceof InstanceMismatch) && !(error instanceof ParameterError)) throw error;
    return instanceOf(row.type, version, at);
  }
}

/**
 * The view of one serve: the card is the item, so a new seed gives a new
 * shuffle (06, question 28 (d)). The serve, the answer and the reveal all
 * compute it from the same served seed and instance (ADR-097): the student
 * names choices by position in it, and the key comes back in it. The shuffle
 * reads the instance's own config only, never the live
 * `questions.shuffleable` column.
 */
function viewOf(row: ActiveRow, config: unknown, seed: number): StudentView {
  return { seed, itemId: row.card.id, shuffle: typeOf(row.type).shuffleable(config) };
}

/**
 * The served question, through the one student exit (`studentViewOf`,
 * invariant 4), under the settings of the evaluation where the card was met.
 */
export function servedView(row: ActiveRow, question: ServedQuestion, instance: ReturnType<typeof reviewInstance>, seed: number) {
  const config = loadConfig(row.type, instance.version);
  const view = viewOf(row, config, seed);
  return {
    cardId: row.card.id,
    type: row.type,
    student: studentViewOf(row.type, config, { ...view, defaults: question.defaults }),
  };
}

/**
 * An answer to a served card, graded with the settings of the card's first
 * evaluation on the values and in the view it was served (ADR-056 §5,
 * ADR-097). The answer named displayed positions; it is returned canonical.
 * A grading that is not final — an edit that made the question wait for an
 * LLM or a teacher — is the 404 of a missing card (ADR-041 §3): the caller
 * writes nothing. The key is returned through `studentSolutionViewOf`, for
 * the caller to send once its writes are done.
 */
export async function gradeServed(
  row: ActiveRow,
  question: ServedQuestion,
  served: { seed: number; values: StoredInstance | null },
  input: { answer: unknown; coordinates?: AnswerCoordinates | undefined },
  now: Date,
) {
  const type = typeOf(row.type);
  const instance = reviewInstance(row, question.version, served.seed, served.values);
  const config = loadConfig(row.type, instance.version);
  const view = viewOf(row, config, served.seed);
  let answer: unknown = null;
  if (input.answer !== null && input.answer !== undefined) {
    // The student named displayed positions; stored and graded canonical.
    const entry = answerFromStudent(row.type, config, view, input.answer, input.coordinates);
    if ("issues" in entry) throw new DrillError("answer_invalid");
    // The attempt's rules hold here too: an mcq ticked past `maxSelections`
    // would be truncated to its lowest canonical indices, the key's (ADR-097).
    if (type.answerMisfit?.(config, entry.answer)) throw new DrillError("answer_invalid");
    answer = entry.answer;
  }
  const result = await type.grade(
    config,
    answer,
    drillGradeContext({
      seed: served.seed,
      key: row.card.id,
      itemPoints: type.defaultPoints(config),
      now,
      defaults: question.defaults,
    }),
  );
  if (!isDrillEligible(row.type, result) || result.kind !== "graded") throw new DrillError("not_found");
  return {
    answer,
    instance,
    points: result.points,
    maxPoints: result.maxPoints,
    correctness: drillCorrectness(result.points, result.maxPoints),
    solution: studentSolutionViewOf(row.type, config, view),
  };
}

/**
 * The student's cards served in a round of targeted revision today (ADR-115):
 * the daily session leaves them out until tomorrow, so a key seen in a round
 * never forges a daily rating, and a new round puts them last.
 */
export async function practisedToday(db: DbOrTx, userId: string, day: Day): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ cardId: drillRevisionAnswers.cardId })
    .from(drillRevisionAnswers)
    .innerJoin(drillRevisionRounds, eq(drillRevisionRounds.id, drillRevisionAnswers.roundId))
    .where(and(eq(drillRevisionRounds.userId, userId), gte(drillRevisionAnswers.servedAt, day.start)));
  return new Set(rows.map((r) => r.cardId));
}
