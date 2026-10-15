/**
 * Targeted revision by concept (ADR-115, F-DRILL-08): the student picks one
 * concept of their course and revises it on purpose, in rounds of at most
 * ten of their own cards. Extra practice OUTSIDE the drill's schedule: a
 * round never writes a `drill_reviews` row nor a card, so it feeds neither
 * FSRS, nor the level, nor any read of the daily reviews. It keeps a record
 * of its own — the round and its answers — that the teacher reads as
 * counts.
 *
 * What this file holds by construction:
 *   - the concepts a student may name are the ones {@link revisableConcepts}
 *     lists — the course's declared, validated concepts, the list of the
 *     student's mastery (ADR-098) — and nothing else of the vocabulary
 *     leaves here: the widened coverage stays on the server;
 *   - a round holds the caller's own ACTIVE cards of the classroom whose key
 *     may already reach them (`activeCards`, `keyOpen`, `serving.ts`): never a
 *     question they have not met, never a pool;
 *   - a question reaches the student through `studentViewOf`, its key through
 *     `studentSolutionViewOf` after the answer, under the settings of the
 *     evaluation where the card was met — the daily serve's own code
 *     (`serving.ts`; invariant 4);
 *   - every instant is the server's (invariant 5): a round is served and
 *     answered only within the drill's day it started on;
 *   - a round, a card or a pass out of reach is the 404 of a missing one
 *     (invariant 6).
 */
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, type SQL } from "drizzle-orm";

import type {
  AnswerCoordinates,
  ConceptLang,
  RevisionAnswerResult,
  RevisionRoundStart,
  RevisionServed,
  StudentConceptRef,
  StudentRevisionConcepts,
  StudentRevisionRound,
} from "@quiz/contracts";
import {
  composeRevisionRound,
  drillDayBounds,
  revisionQueue,
  revisionSummary,
  revisionTimeMs,
  type RevisionAnswer,
} from "@quiz/domain";
import { drillRetrievability } from "@quiz/domain/drillSchedule";

import { iso, isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { drillCards, drillRevisionAnswers, drillRevisionRounds, questionConcepts } from "../../db/schema.js";
import { courseConceptsOf, coverage, finalConceptRefs } from "../concept/service.js";
import type { DbOrTx } from "../evaluation/service.js";
import { drawSeed } from "../live/service.js";
import { instanceOf } from "../pool/service.js";
import { studentDrillClassrooms } from "./review.js";
import {
  activeCards,
  DrillError,
  gradeServed,
  loadContext,
  openQuestionOf,
  ownActiveCard,
  practisedToday,
  questionOf,
  reviewInstance,
  servedView,
} from "./serving.js";

type Classroom = { id: string; courseId: string };
type RoundRow = typeof drillRevisionRounds.$inferSelect;

/**
 * THE concepts a student may read of their course (ADR-098 §1, ADR-115): the
 * ones it declares, VALIDATED — a proposed concept is raw teacher text —
 * labelled in their language, by label; nothing of a concept's status,
 * aliases or relations. The student's mastery and targeted revision share it.
 */
export async function revisableConcepts(db: DbOrTx, classroom: Classroom, lang: ConceptLang): Promise<StudentConceptRef[]> {
  return (await courseConceptsOf(db, classroom.courseId, lang))
    .filter((c) => c.status === "validated")
    .map(({ id, label, qualifier }) => ({ id, label, qualifier }));
}

/** Whether the caller may revise in this classroom: its drill on, not archived, their student seat, not opted out. */
async function revisionOpen(db: Db, classroomId: string, userId: string): Promise<boolean> {
  const [room] = await studentDrillClassrooms(db, userId, classroomId);
  return room !== undefined && room.optedOutAt === null;
}

/** `GET …/revision/concepts`: the concepts on offer, none unless revision is open to the caller. */
export async function studentRevisionConcepts(
  db: Db,
  classroom: Classroom,
  userId: string,
  lang: ConceptLang,
): Promise<StudentRevisionConcepts> {
  if (!(await revisionOpen(db, classroom.id, userId))) return { available: false, concepts: [] };
  return { available: true, concepts: await revisableConcepts(db, classroom, lang) };
}

/**
 * Starts a round on `conceptId`, one of the concepts on offer (else the 404
 * of a missing one): the caller's own active cards of the classroom whose
 * key may reach them and whose question carries a concept the chosen one
 * covers (itself or a narrower one, `coverage`), ordered and cut by
 * `composeRevisionRound` — the cards served in a round today last. No such
 * card: `{ round: null }`, and nothing written.
 */
export async function startRound(
  db: Db,
  classroom: Classroom,
  userId: string,
  conceptId: string,
  lang: ConceptLang,
  now: Date,
): Promise<RevisionRoundStart> {
  if (!(await revisionOpen(db, classroom.id, userId))) throw new DrillError("not_found");
  const concept = (await revisableConcepts(db, classroom, lang)).find((c) => c.id === conceptId);
  if (!concept) throw new DrillError("not_found");

  const active = await activeCards(db, and(eq(drillCards.userId, userId), eq(drillCards.classroomId, classroom.id)));
  const context = await loadContext(db, active);
  const open = active.filter((row) => questionOf(row, context)?.open === true);
  const covered = (await coverage(db, [conceptId])).get(conceptId)!;
  const questionIds = [...new Set(open.map((r) => r.card.questionId))];
  const onConcept =
    questionIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await db
              .selectDistinct({ questionId: questionConcepts.questionId })
              .from(questionConcepts)
              .where(and(inArray(questionConcepts.questionId, questionIds), inArray(questionConcepts.conceptId, covered)))
          ).map((r) => r.questionId),
        );
  const practised = await practisedToday(db, userId, drillDayBounds(now));
  const rows = open.filter((r) => onConcept.has(r.card.questionId));
  const ids = composeRevisionRound(
    rows.map(({ card }) => ({
      id: card.id,
      isNew: card.lastReviewAt === null,
      retrievability: drillRetrievability(card, now),
      createdAt: card.createdAt,
      practisedToday: practised.has(card.id),
    })),
  );
  if (ids.length === 0) return { round: null };

  const id = randomUUID();
  await db.insert(drillRevisionRounds).values({ id, userId, classroomId: classroom.id, conceptId, cardIds: ids, startedAt: now });
  const rowOf = new Map(rows.map((r) => [r.card.id, r]));
  return {
    round: {
      id,
      concept,
      startedAt: iso(now),
      cards: ids.map((cardId) => {
        const { card, type, courseCode, courseName } = rowOf.get(cardId)!;
        return { id: cardId, type, courseCode, courseName, isNew: card.lastReviewAt === null };
      }),
    },
  };
}

/**
 * The caller's round, while it is open: not ended, still within the drill's
 * day it started on, and holding `cardId`; the 404 otherwise. `lock` takes
 * the round's row for the rest of the transaction.
 */
async function openRound(db: DbOrTx, userId: string, roundId: string, cardId: string, now: Date, lock = false): Promise<RoundRow> {
  const query = db
    .select()
    .from(drillRevisionRounds)
    .where(and(eq(drillRevisionRounds.id, roundId), eq(drillRevisionRounds.userId, userId)));
  const [round] = lock ? await query.for("update") : await query;
  if (!round || round.endedAt !== null || now >= drillDayBounds(round.startedAt).end || !round.cardIds.includes(cardId)) {
    throw new DrillError("not_found");
  }
  return round;
}

/** A card's passes in a round. */
const passesOf = (db: DbOrTx, roundId: string, cardId: string, where?: SQL) =>
  db
    .select()
    .from(drillRevisionAnswers)
    .where(and(eq(drillRevisionAnswers.roundId, roundId), eq(drillRevisionAnswers.cardId, cardId), where))
    .orderBy(asc(drillRevisionAnswers.pass));

/**
 * Serves a card of a round at its next pass: the first, or the second once
 * the first was answered wrong; a card with no pass left is a 409
 * `revision_answered`. The pass is written once (a new seed and its
 * values) and read back, so a reload — or two tabs — keeps one seed. The
 * question goes through the daily serve's own exit, under the settings of
 * the evaluation where the card was met.
 */
export async function serveRound(db: Db, userId: string, roundId: string, cardId: string, now: Date): Promise<RevisionServed> {
  await openRound(db, userId, roundId, cardId, now);
  const row = await ownActiveCard(db, userId, cardId);
  const question = await openQuestionOf(db, row);
  const [first, second] = await passesOf(db, roundId, cardId);
  const pass = !first?.answeredAt ? 1 : first.correctness === "wrong" && !second?.answeredAt ? 2 : null;
  if (pass === null) throw new DrillError("revision_answered");

  // A pass already served (a reload) draws nothing; two tabs serving at once
  // insert one row, and both read it back.
  let served = pass === 1 ? first : second;
  let fresh = null;
  if (!served) {
    const seed = drawSeed();
    fresh = instanceOf(row.type, question.version, { seed, itemId: row.card.id });
    await db
      .insert(drillRevisionAnswers)
      .values({ id: randomUUID(), roundId, cardId, pass, servedAt: now, serveSeed: seed, serveValues: fresh.stored })
      .onConflictDoNothing();
    [served] = await passesOf(db, roundId, cardId, eq(drillRevisionAnswers.pass, pass));
    if (served!.serveSeed !== seed) fresh = null;
  }
  const { serveSeed, serveValues } = served!;
  const instance = fresh ?? reviewInstance(row, question.version, serveSeed, serveValues);
  return { ...servedView(row, question, instance, serveSeed), pass };
}

/**
 * The answer to the card's served pass, in one transaction under the round's
 * lock and the pass's: graded as the daily review is (`gradeServed`), its
 * time the server's interval from the serve, capped; no answer and no
 * confidence stored, no review written, the card untouched. A first pass
 * adds to the round's counters; the round ends when nothing is left to
 * answer (`revisionQueue`). A grading that is not final writes nothing (the
 * 404 of `gradeServed`). The key comes back through `studentSolutionViewOf`.
 */
export async function answerRound(
  db: Db,
  userId: string,
  roundId: string,
  cardId: string,
  input: { answer: unknown; coordinates?: AnswerCoordinates | undefined },
  now: Date,
): Promise<RevisionAnswerResult> {
  return db.transaction(async (tx) => {
    const round = await openRound(tx, userId, roundId, cardId, now, true);
    const [served] = await passesOf(tx, roundId, cardId, isNull(drillRevisionAnswers.answeredAt)).limit(1).for("update");
    const row = await ownActiveCard(tx, userId, cardId);
    const question = await openQuestionOf(tx, row);
    if (!served) throw new DrillError("drill_not_served");
    const graded = await gradeServed(row, question, { seed: served.serveSeed, values: served.serveValues }, input, now);
    const pass = served.pass as 1 | 2;
    const answer: RevisionAnswer = { cardId, pass, correctness: graded.correctness };
    await tx
      .update(drillRevisionAnswers)
      .set({ answeredAt: now, correctness: graded.correctness, timeMs: revisionTimeMs(served.servedAt, now) })
      .where(eq(drillRevisionAnswers.id, served.id));

    // The counters grow by this answer alone, so a card the teacher removes
    // later (its passes cascade) leaves them as they were.
    const delta = revisionSummary([answer]);
    const answered = await tx
      .select({ cardId: drillRevisionAnswers.cardId, pass: drillRevisionAnswers.pass, correctness: drillRevisionAnswers.correctness })
      .from(drillRevisionAnswers)
      .where(and(eq(drillRevisionAnswers.roundId, roundId), isNotNull(drillRevisionAnswers.answeredAt)))
      .orderBy(asc(drillRevisionAnswers.answeredAt), asc(drillRevisionAnswers.pass));
    const answers = answered.map((a): RevisionAnswer => ({ cardId: a.cardId, pass: a.pass as 1 | 2, correctness: a.correctness! }));
    const left = revisionQueue({ order: round.cardIds, answers });
    await tx
      .update(drillRevisionRounds)
      .set({
        cardsServed: round.cardsServed + delta.cardsServed,
        cardsCorrect: round.cardsCorrect + delta.cardsCorrect,
        ...(left.length === 0 ? { endedAt: now } : {}),
      })
      .where(eq(drillRevisionRounds.id, roundId));
    return {
      correctness: graded.correctness,
      points: graded.points,
      maxPoints: graded.maxPoints,
      solution: graded.solution,
      requeued: pass === 1 && left.some((e) => e.cardId === cardId && e.pass === 2),
    };
  });
}

/** Ends the caller's round (the student leaves it); ending it again changes nothing. A round not theirs: the 404. */
export async function endRound(db: Db, userId: string, roundId: string, now: Date): Promise<void> {
  const mine = and(eq(drillRevisionRounds.id, roundId), eq(drillRevisionRounds.userId, userId));
  await db
    .update(drillRevisionRounds)
    .set({ endedAt: now })
    .where(and(mine, isNull(drillRevisionRounds.endedAt)));
  const [round] = await db.select({ id: drillRevisionRounds.id }).from(drillRevisionRounds).where(mine);
  if (!round) throw new DrillError("not_found");
}

/**
 * `GET …/revision/rounds`: the caller's own rounds of the classroom with a
 * card answered, newest first — what their teacher sees of them (ADR-115).
 * A round names its concept only while it is, after a merge is followed,
 * still one of {@link revisableConcepts}; null otherwise.
 */
export async function studentRevisionRounds(
  db: Db,
  classroom: Classroom,
  userId: string,
  lang: ConceptLang,
): Promise<StudentRevisionRound[]> {
  const rounds = await db
    .select()
    .from(drillRevisionRounds)
    .where(
      and(
        eq(drillRevisionRounds.userId, userId),
        eq(drillRevisionRounds.classroomId, classroom.id),
        gt(drillRevisionRounds.cardsServed, 0),
      ),
    )
    .orderBy(desc(drillRevisionRounds.startedAt), desc(drillRevisionRounds.id));
  if (rounds.length === 0) return [];
  const conceptIds = [...new Set(rounds.flatMap((r) => (r.conceptId === null ? [] : [r.conceptId])))];
  const [offered, finals] = await Promise.all([revisableConcepts(db, classroom, lang), finalConceptRefs(db, conceptIds, lang)]);
  const offeredById = new Map(offered.map((c) => [c.id, c]));
  const nameOf = (id: string | null) => {
    const final = id === null ? undefined : finals.get(id);
    return (final && offeredById.get(final.id)) ?? null;
  };
  return rounds.map((r) => ({
    id: r.id,
    concept: nameOf(r.conceptId),
    startedAt: iso(r.startedAt),
    endedAt: isoOrNull(r.endedAt),
    cardsServed: r.cardsServed,
    cardsCorrect: r.cardsCorrect,
  }));
}
