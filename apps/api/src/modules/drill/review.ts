/**
 * The student's side of the drill (ADR-041 §4–6, F-DRILL-02/03): today's
 * session, a card served, the time it stays on screen, and the review.
 *
 * What this file holds by construction:
 *   - a question reaches the student only through `studentView`, its key only
 *     through `studentSolutionView`, after the answer (invariant 4, 06,
 *     question 28 (h));
 *   - every instant is the server's (invariant 5): the serve, each report of
 *     the tab's visibility, the answer. The active time is summed here from
 *     those instants, each interval capped by `DWELL_IDLE_CAP_MS` (ADR-039);
 *   - a card is served only while it is ACTIVE ({@link activeCards}): its
 *     classroom has the drill on and is not archived (06, question 28 (g)),
 *     the student still holds a student seat there and has not opted out,
 *     and the question is not deleted. Anything else is the 404 of a
 *     missing card (invariant 6).
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";

import type { DrillDeviceClass, DrillReviewResult, DrillServed, DrillSession } from "@quiz/contracts";
import {
  composeDrillSession,
  drillCorrectness,
  drillDayBounds,
  DRILL_NEW_PER_DAY,
  DRILL_SESSION_BUDGET_MS,
  drillRating,
  drillReferenceMs,
  DWELL_IDLE_CAP_MS,
  isDrillEligible,
} from "@quiz/domain";
import {
  drillRetrievability,
  newDrillCard,
  reviewDrillCard,
  type DrillCard,
} from "@quiz/domain/drillSchedule";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import {
  classrooms,
  courses,
  drillCards,
  drillReviews,
  enrollments,
  questionTags,
  questions,
} from "../../db/schema.js";
import { byId, gradeDefaults } from "../evaluation/service.js";
import { DomainError } from "../http.js";
import { isShuffleable, studentSolutionView, studentView } from "../live/studentView.js";
import { loadConfig, typeOf } from "../pool/config.js";
import { currentVersions, keyHashOf, NO_RUNNER } from "./lifecycle.js";

export class DrillError extends DomainError {
  override name = "DrillError";
}

/** A card that is not the caller's, or not active: indistinguishable from a missing one. */
export class DrillCardNotFound extends DrillError {
  constructor() {
    super("not_found", 404);
  }
}

/** An answer to a card that was not served (or already answered). */
export class DrillNotServed extends DrillError {
  constructor() {
    super("drill_not_served", 409, "serve the card before answering it");
  }
}

/** The answer does not satisfy the type's own schema. */
export class DrillAnswerInvalid extends DrillError {
  constructor() {
    super("answer_invalid", 422);
  }
}

/**
 * The question no longer grades automatically and finally (an edit gave it
 * an `llm` matcher): the card leaves the drill (ADR-041 §3).
 */
export class DrillCardRetired extends DrillError {
  constructor() {
    super("drill_card_retired", 409, "this question can no longer be drilled");
  }
}

/** A 32-bit seed, drawn once per review (06, question 28 (i)). */
function drawSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/** The cards the drill may serve, with what the session needs to know of them. */
function activeCards(db: Db, where: SQL | undefined) {
  return db
    .select({
      card: drillCards,
      type: questions.type,
      shuffleable: questions.shuffleable,
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

async function ownActiveCard(db: Db, userId: string, cardId: string) {
  const [row] = await activeCards(db, and(eq(drillCards.id, cardId), eq(drillCards.userId, userId)));
  if (!row) throw new DrillCardNotFound();
  return row;
}

const stateOf = (card: typeof drillCards.$inferSelect): DrillCard => ({
  stability: card.stability,
  difficulty: card.difficulty,
  dueAt: card.dueAt,
  lastReviewAt: card.lastReviewAt,
  reps: card.reps,
  lapses: card.lapses,
});

/**
 * The reference time of each question for one student on one device class
 * (ADR-041 §4, `drillReferenceMs`): the correct reviews of every student on
 * that class, and the student's own latest one. Read before the review being
 * rated is written. No estimate per type in v1: a right answer with no
 * reference is rated Good (ADR-041 §10, item 7).
 */
async function referenceTimes(
  db: Db,
  questionIds: readonly string[],
  device: DrillDeviceClass,
  userId: string,
): Promise<Map<string, number | null>> {
  if (questionIds.length === 0) return new Map();
  const rows = await db
    .select({
      questionId: drillCards.questionId,
      userId: drillCards.userId,
      elapsedMs: drillReviews.elapsedMs,
    })
    .from(drillReviews)
    .innerJoin(drillCards, eq(drillCards.id, drillReviews.cardId))
    .where(
      and(
        inArray(drillCards.questionId, [...questionIds]),
        eq(drillReviews.correctness, "right"),
        eq(drillReviews.deviceClass, device),
      ),
    )
    .orderBy(drillReviews.reviewedAt);
  const all = new Map<string, number[]>();
  const own = new Map<string, number>();
  for (const row of rows) {
    all.set(row.questionId, [...(all.get(row.questionId) ?? []), row.elapsedMs]);
    if (row.userId === userId) own.set(row.questionId, row.elapsedMs);
  }
  return new Map(
    questionIds.map((id) => [
      id,
      drillReferenceMs({ correctTimesMs: all.get(id) ?? [], previousOwnMs: own.get(id) ?? null, typeDefaultMs: null }),
    ]),
  );
}

/**
 * Today's session (F-DRILL-03, ADR-041 §6): the due cards — due before the
 * end of the day, Zurich time — then the new ones up to the day's cap, until
 * the budget is spent, courses and tags interleaved. An empty day gives the
 * next due date (06, question 28 (b)).
 */
export async function drillSession(
  db: Db,
  userId: string,
  device: DrillDeviceClass,
  now: Date,
): Promise<DrillSession> {
  const rows = await activeCards(db, eq(drillCards.userId, userId));
  const day = drillDayBounds(now);
  const questionIds = [...new Set(rows.map((r) => r.card.questionId))];
  const [introduced] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(
      db
        .select({ cardId: drillReviews.cardId })
        .from(drillReviews)
        .innerJoin(drillCards, eq(drillCards.id, drillReviews.cardId))
        .where(eq(drillCards.userId, userId))
        .groupBy(drillReviews.cardId)
        .having(sql`min(${drillReviews.reviewedAt}) >= ${day.start.toISOString()}::timestamptz`)
        .as("introduced"),
    );
  const tags = questionIds.length === 0
    ? []
    : await db
        .select({ questionId: questionTags.questionId, tag: sql<string>`min(${questionTags.tag})` })
        .from(questionTags)
        .where(inArray(questionTags.questionId, questionIds))
        .groupBy(questionTags.questionId);
  const tagOf = new Map(tags.map((t) => [t.questionId, t.tag]));
  const references = await referenceTimes(db, questionIds, device, userId);

  const rowOf = new Map(rows.map((r) => [r.card.id, r]));
  const ids = composeDrillSession({
    cards: rows.map(({ card, courseCode }) => ({
      id: card.id,
      isNew: card.lastReviewAt === null,
      dueAt: card.dueAt,
      retrievability: drillRetrievability(stateOf(card), now),
      referenceMs: references.get(card.questionId) ?? null,
      group: `${courseCode}\u0000${tagOf.get(card.questionId) ?? ""}`,
    })),
    // "Due" is due before the day ends: FSRS counts whole days from the
    // instant of the last review, and a card due at 14:00 belongs to the
    // morning's session.
    now: new Date(day.end.getTime() - 1),
    budgetMs: DRILL_SESSION_BUDGET_MS,
    newAllowed: DRILL_NEW_PER_DAY - (introduced?.n ?? 0),
  });

  let nextDueAt: Date | null = null;
  if (ids.length === 0 && rows.length > 0) {
    for (const { card } of rows) {
      // A new card held back by the day's cap is due tomorrow.
      const at = card.lastReviewAt === null ? day.end : card.dueAt;
      if (nextDueAt === null || at < nextDueAt) nextDueAt = at;
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

type ActiveRow = Awaited<ReturnType<typeof ownActiveCard>>;

/** The question of a card as the student sees it, and what grading it needs. */
async function questionOf(db: Db, row: ActiveRow, seed: number) {
  const version = (await currentVersions(db, [row.card.questionId])).get(row.card.questionId);
  // A question in the drill was published to be in an evaluation.
  if (!version) throw new DrillCardNotFound();
  const evaluation = await byId(db, row.card.evaluationId);
  if (!evaluation) throw new DrillCardNotFound();
  const stored = { config: version.config, configVersion: version.configVersion };
  const view = {
    type: row.type,
    version: stored,
    seed,
    // The card is the item: the shuffle stream is per card, and a new seed
    // per review gives new choices' order (06, question 28 (d)).
    itemId: row.card.id,
    shuffle: row.shuffleable && isShuffleable(row.type, stored),
  };
  // The settings of the evaluation where the card was met first (06, question 28 (e)).
  const defaults = gradeDefaults(evaluation);
  return { version: stored, view, defaults };
}

/**
 * Serves a card: a new seed, the question on screen from now. Serving again
 * before the answer (a reload) keeps the seed and the time already counted,
 * and reopens the interval on screen if the tab had hidden it.
 */
export async function serveCard(db: Db, userId: string, cardId: string, now: Date): Promise<DrillServed> {
  const row = await ownActiveCard(db, userId, cardId);
  const at = sql`${now.toISOString()}::timestamptz`;
  // One conditional statement each: two tabs serving at once share one seed.
  await db
    .update(drillCards)
    .set({ serveSeed: drawSeed(), servedAt: now, shownSince: now, activeMs: 0 })
    .where(and(eq(drillCards.id, cardId), isNull(drillCards.serveSeed)));
  const [served] = await db
    .update(drillCards)
    .set({ shownSince: sql`coalesce(${drillCards.shownSince}, ${at})` })
    .where(eq(drillCards.id, cardId))
    .returning({ seed: drillCards.serveSeed });
  const { view, defaults } = await questionOf(db, row, served!.seed!);
  return { cardId, type: row.type, student: studentView({ ...view, defaults }) };
}

/** The credit of the open interval at `now`, capped (ADR-039): SQL on `drill_cards`. */
function openCredit(now: Date): SQL {
  const at = sql`${now.toISOString()}::timestamptz`;
  return sql`case when ${drillCards.shownSince} is null then 0 else least(${DWELL_IDLE_CAP_MS}, greatest(0, floor(extract(epoch from (${at} - ${drillCards.shownSince})) * 1000)))::int end`;
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
  if (!row) throw new DrillNotServed();
}

/**
 * The review (F-DRILL-02): the answer graded with the settings of the card's
 * first evaluation, its active time summed by the server, the rating of
 * strategy A against the reference time of the device class, the card
 * rescheduled by FSRS — reset first when the answer key changed since it
 * was last scheduled (ADR-041 §7) — and the key shown.
 */
export async function answerCard(
  db: Db,
  userId: string,
  cardId: string,
  input: { answer: unknown; deviceClass: DrillDeviceClass },
  now: Date,
): Promise<DrillReviewResult> {
  const row = await ownActiveCard(db, userId, cardId);
  const type = typeOf(row.type);
  let answer: unknown = null;
  if (input.answer !== null && input.answer !== undefined) {
    const parsed = type.answerSchema.safeParse(input.answer);
    if (!parsed.success) throw new DrillAnswerInvalid();
    answer = parsed.data;
  }
  const references = await referenceTimes(db, [row.card.questionId], input.deviceClass, userId);
  const referenceMs = references.get(row.card.questionId) ?? null;

  return db.transaction(async (tx) => {
    // The card row is the lock: two answers at once rate the card once.
    const [locked] = await tx
      .select({ card: drillCards, credit: openCredit(now) })
      .from(drillCards)
      .where(eq(drillCards.id, cardId))
      .for("update");
    if (!locked || locked.card.serveSeed === null) throw new DrillNotServed();
    const card = locked.card;
    const seed = card.serveSeed!;
    const { version, view, defaults } = await questionOf(tx as unknown as Db, { ...row, card }, seed);
    const config = loadConfig(row.type, version);
    const result = await type.grade(config, answer, {
      seed,
      itemId: card.id,
      attemptId: card.id,
      itemPoints: type.defaultPoints(config),
      now,
      runner: NO_RUNNER,
      defaults,
    });
    if (!isDrillEligible(row.type, result) || result.kind !== "graded") {
      await tx.delete(drillCards).where(eq(drillCards.id, cardId));
      throw new DrillCardRetired();
    }
    const correctness = drillCorrectness(result.points, result.maxPoints);
    const activeMs = card.activeMs + Number(locked.credit);
    const rating = drillRating({ correctness, activeMs, referenceMs });
    const keyHash = keyHashOf(row.type, version);
    const before = keyHash === card.keyHash ? stateOf(card) : newDrillCard(now);
    const next = reviewDrillCard(before, rating, now);
    await tx.insert(drillReviews).values({
      id: randomUUID(),
      cardId,
      rating,
      correctness,
      elapsedMs: activeMs,
      deviceClass: input.deviceClass,
      reviewedAt: now,
      answerPayload: answer,
    });
    await tx
      .update(drillCards)
      .set({
        ...next,
        keyHash,
        serveSeed: null,
        servedAt: null,
        shownSince: null,
        activeMs: 0,
      })
      .where(eq(drillCards.id, cardId));
    return {
      correctness,
      rating,
      points: result.points,
      maxPoints: result.maxPoints,
      activeMs,
      referenceMs: referenceMs === null ? null : Math.round(referenceMs),
      dueAt: iso(next.dueAt),
      solution: studentSolutionView(view),
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
