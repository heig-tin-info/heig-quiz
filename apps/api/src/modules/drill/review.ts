/**
 * The student's side of the drill (ADR-041 §4–6, F-DRILL-02/03): today's
 * session, a card served, the time it stays on screen, and the review.
 *
 * What this file holds by construction:
 *   - a question reaches the student only through `studentViewOf`, its key only
 *     through `studentSolutionViewOf`, after the answer (invariant 4, 06,
 *     question 28 (h));
 *   - every instant is the server's (invariant 5): the serve, each report of
 *     the tab's visibility, the answer. The active time is summed here from
 *     those instants, each interval capped by `DWELL_IDLE_CAP_MS` (ADR-039);
 *   - a card is reached only while it is ACTIVE (`activeCards`, `serving.ts`),
 *     and it is served or answered only when TODAY's session would hand it
 *     out ({@link servableToday}) and its evaluation lets the key reach the
 *     student (`keyOpen`). Anything else is the 404 of a missing card
 *     (invariant 6) — which is also what closes answering a card twice in a
 *     day. Extra practice is targeted revision (`revision.ts`, ADR-115), on
 *     routes of its own that never write a review: a card served in one of
 *     its rounds today is not servable here before tomorrow.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";

import type {
  AnswerCoordinates,
  DrillCalibrationLevel,
  DrillDeviceClass,
  DrillReviewResult,
  DrillServed,
  DrillSession,
} from "@quiz/contracts";
import {
  composeDrillSession,
  drillCalibration,
  drillConfidenceDue,
  drillConfidenceOutcome,
  type DrillConfidence,
  drillDayBounds,
  DRILL_NEW_PER_DAY,
  DRILL_SESSION_BUDGET_MS,
  drillRating,
  drillReferenceOf,
  DWELL_IDLE_CAP_MS,
} from "@quiz/domain";
import {
  drillRetrievability,
  newDrillCard,
  reviewDrillCard,
  type DrillCard,
} from "@quiz/domain/drillSchedule";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { classrooms, courses, drillCards, drillReviews, enrollments, questionConcepts } from "../../db/schema.js";
import type { DbOrTx } from "../evaluation/service.js";
import { drawSeed } from "../live/service.js";
import { instanceOf } from "../pool/service.js";
import { keyHashOf } from "./lifecycle.js";
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
  type Day,
} from "./serving.js";

type CardRow = typeof drillCards.$inferSelect;

const stateOf = (card: CardRow): DrillCard => ({
  stability: card.stability,
  difficulty: card.difficulty,
  dueAt: card.dueAt,
  lastReviewAt: card.lastReviewAt,
  reps: card.reps,
  lapses: card.lapses,
});

/** New cards the student met for the first time today (their first review is today). */
async function introducedToday(db: DbOrTx, userId: string, day: Day): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(drillCards)
    .where(
      and(
        eq(drillCards.userId, userId),
        sql`(select min(${drillReviews.reviewedAt}) from ${drillReviews} where ${drillReviews.cardId} = ${drillCards.id}) >= ${day.start.toISOString()}::timestamptz`,
      ),
    );
  return row?.n ?? 0;
}

/**
 * Held back for the rest of the day: reviewed already today (a card is
 * reviewed at most once a day), or served in a round of targeted revision
 * today (ADR-115), whose key would otherwise forge a daily rating.
 */
function heldToday(card: CardRow, day: Day, practised: ReadonlySet<string>): boolean {
  return (card.lastReviewAt !== null && card.lastReviewAt >= day.start) || practised.has(card.id);
}

/**
 * Whether today's session may hand this card out (F-DRILL-03): not held
 * back today ({@link heldToday}), and either due before the day ends or new
 * while the day's cap of new cards is not reached. The same rule the session
 * is composed under, the budget aside: the budget orders a session, it does
 * not forbid a card.
 */
function servableToday(card: CardRow, day: Day, introduced: number, practised: ReadonlySet<string>): boolean {
  if (heldToday(card, day, practised)) return false;
  if (card.lastReviewAt === null) return introduced < DRILL_NEW_PER_DAY;
  return card.dueAt < day.end;
}

/** What holds cards back today: the new cards already introduced, and those revised in a round. */
async function todayOf(db: DbOrTx, userId: string, day: Day) {
  const [introduced, practised] = await Promise.all([introducedToday(db, userId, day), practisedToday(db, userId, day)]);
  return { introduced, practised };
}

/**
 * The card, if today's session may hand it out and its key may reach the
 * student; the 404 otherwise. A card held back keeps its history: it is
 * simply not served, until it may be again.
 */
async function servable(db: DbOrTx, userId: string, cardId: string, now: Date) {
  const row = await ownActiveCard(db, userId, cardId);
  const day = drillDayBounds(now);
  const { introduced, practised } = await todayOf(db, userId, day);
  if (!servableToday(row.card, day, introduced, practised)) throw new DrillError("not_found");
  return { row, question: await openQuestionOf(db, row) };
}

/**
 * The reference time of each question for one student on one device class
 * (ADR-041 §4, `drillReferenceOf`): the count and the median of the correct
 * reviews of every student on that class, and the student's own latest
 * correct time, all three computed by the database. Read before the review
 * being rated is written. No estimate per type in v1: a right answer with no
 * reference is rated Good (ADR-041 §10, item 7).
 */
async function referenceTimes(
  db: DbOrTx,
  questionIds: readonly string[],
  device: DrillDeviceClass,
  userId: string,
): Promise<Map<string, number | null>> {
  if (questionIds.length === 0) return new Map();
  const correct = and(
    inArray(drillCards.questionId, [...questionIds]),
    eq(drillReviews.correctness, "right"),
    eq(drillReviews.deviceClass, device),
  );
  const [all, own] = await Promise.all([
    db
      .select({
        questionId: drillCards.questionId,
        n: sql<number>`count(*)::int`,
        median: sql<number>`percentile_cont(0.5) within group (order by ${drillReviews.elapsedMs})`,
      })
      .from(drillReviews)
      .innerJoin(drillCards, eq(drillCards.id, drillReviews.cardId))
      .where(correct)
      .groupBy(drillCards.questionId),
    db
      .selectDistinctOn([drillCards.questionId], {
        questionId: drillCards.questionId,
        elapsedMs: drillReviews.elapsedMs,
      })
      .from(drillReviews)
      .innerJoin(drillCards, eq(drillCards.id, drillReviews.cardId))
      .where(and(correct, eq(drillCards.userId, userId)))
      .orderBy(drillCards.questionId, desc(drillReviews.reviewedAt)),
  ]);
  const stats = new Map(all.map((r) => [r.questionId, r]));
  const mine = new Map(own.map((r) => [r.questionId, r.elapsedMs]));
  return new Map(
    questionIds.map((id) => [
      id,
      drillReferenceOf({
        correctCount: stats.get(id)?.n ?? 0,
        correctMedianMs: stats.has(id) ? Number(stats.get(id)!.median) : null,
        previousOwnMs: mine.get(id) ?? null,
        typeDefaultMs: null,
      }),
    ]),
  );
}

/**
 * Today's session (F-DRILL-03, ADR-041 §6): the due cards — due before the
 * end of the day, Zurich time — then the new ones up to the day's cap, until
 * the budget is spent, courses and concepts interleaved (a question by its
 * first concept id, ADR-081 third addendum §8). A card reviewed or revised today,
 * or whose key may not reach the student yet, is left out. An empty day
 * gives the next due date (06, question 28 (b)).
 */
export async function drillSession(
  db: Db,
  userId: string,
  device: DrillDeviceClass,
  now: Date,
): Promise<DrillSession> {
  const day = drillDayBounds(now);
  const active = await activeCards(db, eq(drillCards.userId, userId));
  const context = await loadContext(db, active);
  const rows = active.filter((row) => questionOf(row, context)?.open === true);
  const questionIds = [...new Set(rows.map((r) => r.card.questionId))];
  const { introduced, practised } = await todayOf(db, userId, day);
  const firsts =
    questionIds.length === 0
      ? []
      : await db
          .select({
            questionId: questionConcepts.questionId,
            conceptId: sql<string>`min(${questionConcepts.conceptId}::text)`,
          })
          .from(questionConcepts)
          .where(inArray(questionConcepts.questionId, questionIds))
          .groupBy(questionConcepts.questionId);
  const conceptOf = new Map(firsts.map((t) => [t.questionId, t.conceptId]));
  const references = await referenceTimes(db, questionIds, device, userId);

  const rowOf = new Map(rows.map((r) => [r.card.id, r]));
  const ids = composeDrillSession({
    cards: rows
      .filter(({ card }) => !heldToday(card, day, practised))
      .map(({ card, courseCode }) => ({
        id: card.id,
        isNew: card.lastReviewAt === null,
        dueAt: card.dueAt,
        retrievability: drillRetrievability(stateOf(card), now),
        referenceMs: references.get(card.questionId) ?? null,
        group: `${courseCode}\u0000${conceptOf.get(card.questionId) ?? ""}`,
      })),
    // "Due" is due before the day ends: FSRS counts whole days from the
    // instant of the last review, and a card due at 14:00 belongs to the
    // morning's session.
    now: new Date(day.end.getTime() - 1),
    budgetMs: DRILL_SESSION_BUDGET_MS,
    newAllowed: DRILL_NEW_PER_DAY - introduced,
  });

  let nextDueAt: Date | null = null;
  if (ids.length === 0) {
    for (const { card } of rows) {
      // Nothing is left for today: a new card held back by the cap, or a
      // card reviewed or revised today, comes back tomorrow at the earliest.
      const next = card.lastReviewAt === null || card.dueAt < day.end ? day.end : card.dueAt;
      if (nextDueAt === null || next < nextDueAt) nextDueAt = next;
    }
  }
  return {
    cards: ids.map((id) => {
      const { card, type, courseCode, courseName } = rowOf.get(id)!;
      return { id, type, courseCode, courseName, isNew: card.lastReviewAt === null };
    }),
    budgetMs: DRILL_SESSION_BUDGET_MS,
    nextDueAt: nextDueAt === null ? null : iso(nextDueAt),
  };
}

/**
 * Serves a card: a new seed, the question on screen from now. Serving again
 * before the answer (a reload) keeps the seed and the time already counted,
 * and reopens the interval on screen if the tab had hidden it.
 */
export async function serveCard(db: Db, userId: string, cardId: string, now: Date): Promise<DrillServed> {
  const { row, question } = await servable(db, userId, cardId, now);
  const at = sql`${now.toISOString()}::timestamptz`;
  // One conditional statement each: two tabs serving at once share one seed
  // — and the values drawn from it (ADR-056 §5), stored beside it. A card
  // already served (a reload) draws nothing.
  const seed = drawSeed();
  const fresh = row.card.serveSeed === null ? instanceOf(row.type, question.version, { seed, itemId: row.card.id }) : null;
  const claimed = fresh
    ? await db
        .update(drillCards)
        .set({ serveSeed: seed, serveValues: fresh.stored, shownSince: now, activeMs: 0 })
        .where(and(eq(drillCards.id, cardId), isNull(drillCards.serveSeed)))
        .returning({ id: drillCards.id })
    : [];
  const [served] = await db
    .update(drillCards)
    .set({ shownSince: sql`coalesce(${drillCards.shownSince}, ${at})` })
    .where(eq(drillCards.id, cardId))
    .returning({ seed: drillCards.serveSeed, values: drillCards.serveValues });
  const instance =
    fresh && claimed.length > 0 ? fresh : reviewInstance(row, question.version, served!.seed!, served!.values);
  return servedView(row, question, instance, served!.seed!);
}

/** The credit of the open interval at `now`, capped (ADR-039): SQL on `drill_cards`. */
function openCredit(now: Date): SQL<number> {
  const at = sql`${now.toISOString()}::timestamptz`;
  return sql<number>`case when ${drillCards.shownSince} is null then 0 else least(${DWELL_IDLE_CAP_MS}, greatest(0, floor(extract(epoch from (${at} - ${drillCards.shownSince})) * 1000)))::int end`;
}

/**
 * The tab's visibility (ADR-041 §4: the clock pauses while it is hidden).
 * `shown` opens an interval, if none is open; hidden closes it and credits
 * it. A card not served is a 409.
 */
export async function reportShown(
  db: Db,
  userId: string,
  cardId: string,
  shown: boolean,
  now: Date,
): Promise<void> {
  await ownActiveCard(db, userId, cardId);
  const at = sql`${now.toISOString()}::timestamptz`;
  const [row] = await db
    .update(drillCards)
    .set(
      shown
        ? { shownSince: sql`coalesce(${drillCards.shownSince}, ${at})` }
        : { activeMs: sql`${drillCards.activeMs} + ${openCredit(now)}`, shownSince: null },
    )
    .where(and(eq(drillCards.id, cardId), isNotNull(drillCards.serveSeed)))
    .returning({ id: drillCards.id });
  if (!row) throw new DrillError("drill_not_served");
}

/**
 * The review (F-DRILL-02): the answer graded with the settings of the card's
 * first evaluation, its active time summed by the server, the rating of
 * strategy A against the reference time of the device class, the card
 * rescheduled by FSRS — reset first when the answer key changed since it
 * was last scheduled (ADR-041 §7) — and the key shown. The confidence the
 * student stated, if any, is stored, and brings a confident error back
 * tomorrow at the latest; it never changes the rating nor the FSRS state
 * (ADR-085 §2, §4).
 */
export async function answerCard(
  db: Db,
  userId: string,
  cardId: string,
  input: {
    answer: unknown;
    deviceClass: DrillDeviceClass;
    confidence?: number | null | undefined;
    /** ADR-097: the client's `AnswerCoordinates` marker. */
    coordinates?: AnswerCoordinates | undefined;
  },
  now: Date,
): Promise<DrillReviewResult> {
  return db.transaction(async (tx) => {
    // The card row is the lock: two answers at once rate the card once.
    const [locked] = await tx
      .select({ serveSeed: drillCards.serveSeed, serveValues: drillCards.serveValues, credit: openCredit(now) })
      .from(drillCards)
      .where(and(eq(drillCards.id, cardId), eq(drillCards.userId, userId)))
      .for("update");
    if (!locked) throw new DrillError("not_found");
    // Under the lock: the card as it stands, still in today's session.
    const { row, question } = await servable(tx, userId, cardId, now);
    if (locked.serveSeed === null) throw new DrillError("drill_not_served");
    const card = row.card;
    // Graded on the values the student was served (ADR-056 §5), in the view
    // they were served (ADR-097). A review has nobody to wait for (ADR-041
    // §3): a grading that is not final is refused, and nothing is written.
    const { answer, instance, points, maxPoints, correctness, solution } = await gradeServed(
      row,
      question,
      { seed: locked.serveSeed, values: locked.serveValues },
      input,
      now,
    );
    const references = await referenceTimes(tx, [card.questionId], input.deviceClass, userId);
    const referenceMs = references.get(card.questionId) ?? null;
    const activeMs = card.activeMs + Number(locked.credit);
    const rating = drillRating({ correctness, activeMs, referenceMs });
    const keyHash = keyHashOf(row.type, question.version);
    const before = keyHash === card.keyHash ? stateOf(card) : newDrillCard(now);
    // The contract bounds it to 0..4 or nothing.
    const confidence = (input.confidence ?? null) as DrillConfidence | null;
    const scheduled = reviewDrillCard(before, rating, now);
    // FSRS's state as computed; only a confident error's due date is capped
    // to tomorrow (ADR-085 §4, amended 2026-10-08).
    const next = {
      ...scheduled,
      dueAt: drillConfidenceDue(drillConfidenceOutcome(correctness, confidence), scheduled.dueAt, now),
    };
    await tx.insert(drillReviews).values({
      id: randomUUID(),
      cardId,
      rating,
      correctness,
      elapsedMs: activeMs,
      deviceClass: input.deviceClass,
      reviewedAt: now,
      answerPayload: answer,
      values: instance.stored,
      // Stored beside the review: the rating and the FSRS state are computed
      // without it (ADR-085 §2).
      confidence,
    });
    await tx
      .update(drillCards)
      .set({ ...next, keyHash, serveSeed: null, serveValues: null, shownSince: null, activeMs: 0 })
      .where(eq(drillCards.id, cardId));
    return {
      correctness,
      rating,
      points,
      maxPoints,
      activeMs,
      referenceMs: referenceMs === null ? null : Math.round(referenceMs),
      dueAt: iso(next.dueAt),
      solution,
    };
  });
}

/** The classrooms whose drill the student is in or opted out of, for the tab. */
export async function studentDrillClassrooms(db: Db, userId: string, classroomId?: string) {
  const rows = await db
    .select({
      classroomId: classrooms.id,
      classroomName: classrooms.name,
      courseCode: courses.code,
      courseName: courses.name,
      optedOutAt: enrollments.drillOptedOutAt,
    })
    .from(enrollments)
    .innerJoin(classrooms, eq(classrooms.id, enrollments.classroomId))
    .innerJoin(courses, eq(courses.id, classrooms.courseId))
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.staff, false),
        isNotNull(classrooms.drillEnabledAt),
        isNull(classrooms.archivedAt),
        classroomId === undefined ? undefined : eq(classrooms.id, classroomId),
      ),
    )
    .orderBy(courses.code, classrooms.name);
  return rows.map((r) => ({ ...r, optedOutAt: r.optedOutAt === null ? null : iso(r.optedOutAt) }));
}

/**
 * The student's calibration (ADR-085 §8): their own stated reviews, in every
 * classroom, counted by level and correctness, then folded into the five
 * levels by `drillCalibration`. One query, filtered by the card's owner: no
 * other student's row can enter it.
 */
export async function studentCalibration(db: Db, userId: string): Promise<DrillCalibrationLevel[]> {
  const rows = await db
    .select({
      confidence: drillReviews.confidence,
      correctness: drillReviews.correctness,
      count: sql<number>`count(*)::int`,
    })
    .from(drillReviews)
    .innerJoin(drillCards, eq(drillCards.id, drillReviews.cardId))
    .where(and(eq(drillCards.userId, userId), isNotNull(drillReviews.confidence)))
    .groupBy(drillReviews.confidence, drillReviews.correctness);
  return drillCalibration(rows.map((r) => ({ ...r, confidence: r.confidence as DrillConfidence })));
}
