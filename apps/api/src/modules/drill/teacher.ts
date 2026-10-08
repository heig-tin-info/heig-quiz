/**
 * The teacher's view of a classroom's drill (ADR-041 §8, §10 items 8 and 10,
 * #317 slice 4): each student's activity, the weekly progression, the
 * mastery per tag, and the confidence per question (ADR-085 §8). Reads
 * only; the routes load the classroom through `staffAccess` first
 * (invariant 6).
 *
 * What every read holds by construction:
 *   - only the cards met first in THIS classroom count (06, question 28 (j)):
 *     every query starts from `drill_cards.classroom_id`;
 *   - a review made after the student opted out is not counted (28 (k)),
 *     what came before stays ({@link visibleReviews});
 *   - a card's first drill review is decided over its whole history, before
 *     any window or opt-out cut, and left out of the recall rate — the
 *     definition of `drillRecallCounts` (`@quiz/domain`), which the database
 *     test holds this SQL to;
 *   - no read filters deleted questions: a card exists only for a question
 *     an evaluation holds, which the pool refuses to delete, soft or hard
 *     (`isQuestionInUse`), and deleting the evaluation takes the cards and
 *     their reviews with it (the cascade of 28 (a));
 *   - each read is a bounded number of queries, whatever the class size.
 */
import { and, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";

import type { DrillProgress, DrillQuestionConfidence, DrillStudentActivity, DrillTagMastery } from "@quiz/contracts";
import {
  DRILL_RECALLED_MIN_RATING,
  SCHOOL_TIME_ZONE,
  drillConfidenceShown,
  drillConfidenceSplit,
  drillConfidentErrorShare,
  type DrillConfidence,
  drillLocalDate,
  drillProgressRange,
  drillWeekStarts,
} from "@quiz/domain";
import { drillRetrievability } from "@quiz/domain/drillSchedule";

import { iso, isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { drillCards, drillReviews, enrollments, questionTags, questions } from "../../db/schema.js";

const DAY_MS = 86_400_000;

/** The students of the classroom: its non-staff seats. */
const studentSeat = (classroomId: string) => and(eq(enrollments.classroomId, classroomId), eq(enrollments.staff, false));

/**
 * The reviews of the classroom's cards the teacher may see, with the seat
 * they belong to and whether each is its card's first. The window function
 * runs on the card's whole history, then the opt-out cut applies.
 */
function visibleReviews(db: Db, classroomId: string) {
  const ranked = db
    .select({
      cardId: drillReviews.cardId,
      userId: drillCards.userId,
      questionId: drillCards.questionId,
      reviewedAt: drillReviews.reviewedAt,
      rating: drillReviews.rating,
      correctness: drillReviews.correctness,
      confidence: drillReviews.confidence,
      first: sql<boolean>`row_number() over (partition by ${drillReviews.cardId} order by ${drillReviews.reviewedAt}, ${drillReviews.id}) = 1`.as(
        "first",
      ),
    })
    .from(drillReviews)
    .innerJoin(drillCards, eq(drillCards.id, drillReviews.cardId))
    .where(eq(drillCards.classroomId, classroomId))
    .as("ranked");
  return db
    .select({
      enrollmentId: sql<string>`${enrollments.id}`.as("enrollment_id"),
      cardId: ranked.cardId,
      userId: ranked.userId,
      questionId: ranked.questionId,
      reviewedAt: ranked.reviewedAt,
      rating: ranked.rating,
      correctness: ranked.correctness,
      confidence: ranked.confidence,
      first: ranked.first,
    })
    .from(ranked)
    .innerJoin(
      enrollments,
      and(
        studentSeat(classroomId),
        eq(enrollments.userId, ranked.userId),
        or(isNull(enrollments.drillOptedOutAt), sql`${ranked.reviewedAt} < ${enrollments.drillOptedOutAt}`),
      ),
    )
    .as("visible");
}
type Visible = ReturnType<typeof visibleReviews>;

const since = (v: Visible, from: Date) => sql`${v.reviewedAt} >= ${from.toISOString()}::timestamptz`;
const count = (where: SQL) => sql<number>`(count(*) filter (where ${where}))::int`;
/** The repeated reviews, and those recalled, among the rows `where` keeps. */
const recallOf = (v: Visible, where: SQL = sql`true`) => ({
  repeated: count(sql`not ${v.first} and ${where}`),
  recalled: count(sql`not ${v.first} and ${v.rating} >= ${DRILL_RECALLED_MIN_RATING} and ${where}`),
});
/**
 * A review's calendar day on the drill's clock. The zone is a literal, not
 * a bound parameter: the weekly query groups by an expression built on it,
 * and PostgreSQL matches a GROUP BY to its SELECT by text, placeholders
 * included.
 */
const ZONE = sql.raw(`'${SCHOOL_TIME_ZONE}'`);
const localDay = (v: Visible) => sql`(${v.reviewedAt} at time zone ${ZONE})::date`;

/** One row per student seat of the classroom: two queries, whatever its size. */
export async function classroomActivity(db: Db, classroomId: string, now: Date): Promise<DrillStudentActivity[]> {
  const v = visibleReviews(db, classroomId);
  const d30 = new Date(now.getTime() - 30 * DAY_MS);
  const d60 = new Date(now.getTime() - 60 * DAY_MS);
  const [seats, stats] = await Promise.all([
    db
      .select({
        id: enrollments.id,
        nom: enrollments.nom,
        prenom: enrollments.prenom,
        optedOutAt: enrollments.drillOptedOutAt,
      })
      .from(enrollments)
      .where(studentSeat(classroomId))
      .orderBy(enrollments.nom, enrollments.prenom),
    db
      .select({
        enrollmentId: v.enrollmentId,
        questionsSeen: sql<number>`count(distinct ${v.cardId})::int`,
        sessions: sql<number>`count(distinct ${localDay(v)})::int`,
        lastReviewAt: sql<Date>`max(${v.reviewedAt})`.mapWith(drillReviews.reviewedAt),
        last30: count(since(v, d30)),
        all: sql<number>`count(*)::int`,
        r30: recallOf(v, since(v, d30)),
        rPrev: recallOf(v, sql`${v.reviewedAt} < ${d30.toISOString()}::timestamptz and ${since(v, d60)}`),
        rAll: recallOf(v),
      })
      .from(v)
      .groupBy(v.enrollmentId),
  ]);
  const byId = new Map(stats.map((s) => [s.enrollmentId, s]));
  const none = { repeated: 0, recalled: 0 };
  return seats.map((seat) => {
    const s = byId.get(seat.id);
    return {
      enrollmentId: seat.id,
      nom: seat.nom,
      prenom: seat.prenom,
      questionsSeen: s?.questionsSeen ?? 0,
      sessions: s?.sessions ?? 0,
      lastReviewAt: s ? iso(s.lastReviewAt) : null,
      reviews: { last30: s?.last30 ?? 0, all: s?.all ?? 0 },
      recall: { last30: s?.r30 ?? none, previous30: s?.rPrev ?? none, all: s?.rAll ?? none },
      optedOutAt: isoOrNull(seat.optedOutAt),
    };
  });
}

/**
 * One student seat's weeks. Null when the seat is not a student seat of the
 * classroom: the route's 404.
 */
export async function classroomProgress(
  db: Db,
  classroom: { id: string; periodStart: string | null; periodEnd: string | null; drillEnabledAt: Date | null },
  enrollmentId: string,
  now: Date,
): Promise<DrillProgress | null> {
  const [seat] = await db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(and(studentSeat(classroom.id), eq(enrollments.id, enrollmentId)));
  if (!seat) return null;
  const v = visibleReviews(db, classroom.id);
  const week = sql<string>`to_char(date_trunc('week', ${localDay(v)}), 'YYYY-MM-DD')`;
  const rows = await db
    .select({ weekStart: week, reviews: sql<number>`count(*)::int`, recall: recallOf(v) })
    .from(v)
    .where(eq(v.enrollmentId, seat.id))
    .groupBy(week);

  const range = drillProgressRange({
    periodStart: classroom.periodStart,
    periodEnd: classroom.periodEnd,
    enabledOn: classroom.drillEnabledAt ? drillLocalDate(classroom.drillEnabledAt) : null,
    firstReviewOn: rows.map((r) => r.weekStart).sort()[0] ?? null,
    today: drillLocalDate(now),
  });
  if (!range) return { weeks: [] };
  const byWeek = new Map(rows.map((r) => [r.weekStart, r]));
  return {
    weeks: drillWeekStarts(range.from, range.to).map(
      (weekStart) => byWeek.get(weekStart) ?? { weekStart, reviews: 0, recall: { repeated: 0, recalled: 0 } },
    ),
  };
}

/**
 * Per tag, the mean retrievability now of the classroom's reviewed cards,
 * over its current student seats (ADR-041 §10, item 10). One query; the
 * retrievability is FSRS's (`drillRetrievability`), computed here rather
 * than re-derived in SQL. A card's state is its last review's, so a card
 * of a student who opted out stands as it was before (28 (k)). Weakest tag
 * first.
 */
export async function classroomMastery(db: Db, classroomId: string, now: Date): Promise<DrillTagMastery[]> {
  const rows = await db
    .select({ card: drillCards, tag: questionTags.tag })
    .from(drillCards)
    .innerJoin(enrollments, and(studentSeat(classroomId), eq(enrollments.userId, drillCards.userId)))
    .leftJoin(questionTags, eq(questionTags.questionId, drillCards.questionId))
    .where(and(eq(drillCards.classroomId, classroomId), isNotNull(drillCards.lastReviewAt)));

  const tags = new Map<string | null, { cards: Set<string>; students: Set<string>; sum: number }>();
  for (const { card, tag } of rows) {
    const entry = tags.get(tag) ?? { cards: new Set(), students: new Set(), sum: 0 };
    tags.set(tag, entry);
    entry.cards.add(card.id);
    entry.students.add(card.userId);
    entry.sum += drillRetrievability(card, now);
  }
  return [...tags]
    .map(([tag, e]) => ({ tag, cards: e.cards.size, students: e.students.size, retrievability: e.sum / e.cards.size }))
    .sort((a, b) => a.retrievability - b.retrievability || String(a.tag).localeCompare(String(b.tag)));
}

/**
 * Per question, the 2×2 of the classroom's stated reviews (ADR-085 §8):
 * right or wrong × sure or unsure, over the same visible reviews as the
 * activity. AGGREGATED ONLY: a question whose statements come from fewer
 * than `DRILL_CONFIDENCE_MIN_STUDENTS` distinct students is dropped here,
 * so its counts never leave the server. Two queries; the most confident
 * errors among the wrong answers first.
 */
export async function classroomConfidence(db: Db, classroomId: string): Promise<DrillQuestionConfidence[]> {
  const v = visibleReviews(db, classroomId);
  const stated = isNotNull(v.confidence);
  const [counts, perQuestion] = await Promise.all([
    db
      .select({
        questionId: v.questionId,
        confidence: v.confidence,
        correctness: v.correctness,
        count: sql<number>`count(*)::int`,
      })
      .from(v)
      .where(stated)
      .groupBy(v.questionId, v.confidence, v.correctness),
    db
      .select({
        questionId: v.questionId,
        name: questions.internalName,
        students: sql<number>`count(distinct ${v.userId})::int`,
      })
      .from(v)
      .innerJoin(questions, eq(questions.id, v.questionId))
      .where(stated)
      .groupBy(v.questionId, questions.internalName),
  ]);
  return perQuestion
    .filter((q) => drillConfidenceShown(q.students))
    .map((q) => ({
      ...q,
      split: drillConfidenceSplit(
        counts
          .filter((c) => c.questionId === q.questionId)
          .map((c) => ({ ...c, confidence: c.confidence as DrillConfidence })),
      ),
    }))
    .sort(
      (a, b) =>
        (drillConfidentErrorShare(b.split) ?? -1) - (drillConfidentErrorShare(a.split) ?? -1) ||
        b.split.wrongSure - a.split.wrongSure ||
        a.name.localeCompare(b.name),
    );
}
