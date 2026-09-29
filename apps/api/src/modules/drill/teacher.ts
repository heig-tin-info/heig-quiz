/**
 * The teacher's view of a classroom's drill (ADR-041 §8, §10 items 8 and 10,
 * #317 slice 4): each student's activity, the weekly progression, and the
 * mastery per tag. Reads only; the routes load the classroom through
 * `staffAccess` first (invariant 6).
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
 *   - each read is a bounded number of queries, whatever the class size.
 */
import { and, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";

import type { DrillProgress, DrillStudentActivity, DrillTagMastery } from "@quiz/contracts";
import {
  DRILL_RECALLED_MIN_RATING,
  DRILL_TIME_ZONE,
  drillLocalDate,
  drillProgressRange,
  drillWeekStarts,
} from "@quiz/domain";
import { drillRetrievability } from "@quiz/domain/drillSchedule";

import { iso, isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { drillCards, drillReviews, enrollments, questions, questionTags } from "../../db/schema.js";

const DAY_MS = 86_400_000;

/** The students of the classroom: its non-staff seats. */
const studentSeat = (classroomId: string) => and(eq(enrollments.classroomId, classroomId), eq(enrollments.staff, false));

/**
 * The reviews of the classroom's cards the teacher may see, with the seat
 * they belong to and whether each is its card's first. The window function
 * runs on the card's whole history, then the opt-out cut applies.
 */
function visibleReviews(db: Db, classroomId: string, seat?: SQL) {
  const ranked = db
    .select({
      cardId: drillReviews.cardId,
      userId: drillCards.userId,
      reviewedAt: drillReviews.reviewedAt,
      rating: drillReviews.rating,
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
      reviewedAt: ranked.reviewedAt,
      rating: ranked.rating,
      first: ranked.first,
    })
    .from(ranked)
    .innerJoin(
      enrollments,
      and(
        studentSeat(classroomId),
        eq(enrollments.userId, ranked.userId),
        or(isNull(enrollments.drillOptedOutAt), sql`${ranked.reviewedAt} < ${enrollments.drillOptedOutAt}`),
        seat,
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
const ZONE = sql.raw(`'${DRILL_TIME_ZONE}'`);
const localDay = (v: Visible) => sql`(${v.reviewedAt} at time zone ${ZONE})::date`;

/** One row per student seat of the classroom: two queries, whatever its size. */
export async function classroomActivity(db: Db, classroomId: string, now: Date): Promise<DrillStudentActivity[]> {
  const v = visibleReviews(db, classroomId);
  const d7 = new Date(now.getTime() - 7 * DAY_MS);
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
        last7: count(since(v, d7)),
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
      reviews: { last7: s?.last7 ?? 0, last30: s?.last30 ?? 0, all: s?.all ?? 0 },
      recall: { last30: s?.r30 ?? none, previous30: s?.rPrev ?? none, all: s?.rAll ?? none },
      optedOutAt: isoOrNull(seat.optedOutAt),
    };
  });
}

/**
 * The weeks of the progression, for one student seat or, without one, the
 * whole classroom. Null when the seat is not a student seat of the
 * classroom: the route's 404.
 */
export async function classroomProgress(
  db: Db,
  classroom: { id: string; periodStart: string | null; periodEnd: string | null; drillEnabledAt: Date | null },
  enrollmentId: string | undefined,
  now: Date,
): Promise<DrillProgress | null> {
  if (enrollmentId !== undefined) {
    const [seat] = await db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(and(studentSeat(classroom.id), eq(enrollments.id, enrollmentId)));
    if (!seat) return null;
  }
  const v = visibleReviews(db, classroom.id, enrollmentId === undefined ? undefined : eq(enrollments.id, enrollmentId));
  const week = sql<string>`to_char(date_trunc('week', ${localDay(v)}), 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      weekStart: week,
      reviews: sql<number>`count(*)::int`,
      sessions: sql<number>`count(distinct (${v.userId}, ${localDay(v)}))::int`,
      questions: sql<number>`count(distinct ${v.cardId})::int`,
      students: sql<number>`count(distinct ${v.userId})::int`,
      recall: recallOf(v),
    })
    .from(v)
    .groupBy(week);

  const first = rows.map((r) => r.weekStart).sort()[0] ?? null;
  const range = drillProgressRange({
    periodStart: classroom.periodStart,
    periodEnd: classroom.periodEnd,
    enabledOn: classroom.drillEnabledAt ? drillLocalDate(classroom.drillEnabledAt) : null,
    firstReviewOn: first,
    today: drillLocalDate(now),
  });
  if (!range) return { weeks: [] };
  const byWeek = new Map(rows.map((r) => [r.weekStart, r]));
  return {
    weeks: drillWeekStarts(range.from, range.to).map(
      (weekStart) =>
        byWeek.get(weekStart) ?? {
          weekStart,
          reviews: 0,
          sessions: 0,
          questions: 0,
          students: 0,
          recall: { repeated: 0, recalled: 0 },
        },
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
    .innerJoin(questions, and(eq(questions.id, drillCards.questionId), isNull(questions.deletedAt)))
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
