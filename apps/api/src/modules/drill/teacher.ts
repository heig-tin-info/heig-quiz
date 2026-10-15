/**
 * The teacher's view of a classroom's drill (ADR-041 §8, §10 items 8 and 10,
 * #317 slice 4): each student's activity, the weekly progression, the
 * hours of the week they practise at (amendment of 2026-10-14), the mastery
 * per concept, the confidence per question (ADR-085 §8), and who revised
 * which concept in a round of targeted revision (ADR-115). Reads
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
import { and, eq, gt, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";

import type {
  ConceptLang,
  ConceptRef,
  DrillClassroomMastery,
  DrillClassroomRevision,
  DrillConceptMastery,
  DrillHours,
  DrillProgress,
  DrillQuestionConfidence,
  DrillStudentActivity,
} from "@quiz/contracts";
import {
  DRILL_RECALLED_MIN_RATING,
  SCHOOL_TIME_ZONE,
  drillConfidenceShown,
  drillConfidenceSplit,
  drillConfidentErrorShare,
  type DrillConfidence,
  localDate,
  drillProgressRange,
  drillMastery,
  drillWeekStarts,
  type MasteryLine,
  isWeekdayClassHour,
  offHoursShare,
} from "@quiz/domain";
import { drillRetrievability } from "@quiz/domain/drillSchedule";

import { iso, isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import {
  concepts,
  drillCards,
  drillReviews,
  drillRevisionRounds,
  enrollments,
  questionConcepts,
  questions,
} from "../../db/schema.js";
import { byLabel, courseConceptsOf, coverage, finalConceptRefs, toConceptRef } from "../concept/service.js";
import { reviewedMasteryCards } from "./masteryCards.js";

const DAY_MS = 86_400_000;
/** The start of the rolling "last 30 days" every read of this view shares. */
const last30 = (now: Date) => new Date(now.getTime() - 30 * DAY_MS);

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
  const d30 = last30(now);
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

/** Whether `enrollmentId` is a student seat of the classroom: the 404 of the reads of one student. */
async function isStudentSeat(db: Db, classroomId: string, enrollmentId: string): Promise<boolean> {
  const [seat] = await db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(and(studentSeat(classroomId), eq(enrollments.id, enrollmentId)));
  return seat !== undefined;
}

/**
 * When the drill is practised (ADR-041 §8, amendment of 2026-10-14): the
 * visible reviews of the last 30 days, grouped by Zurich weekday and hour.
 * The classroom's grid counts distinct students per slot; one student's
 * (`enrollmentId`), their reviews. Null when that seat is not a student seat
 * of the classroom: the route's 404. One query; the weekday and the hour
 * are built on the literal zone, as `localDay`, so GROUP BY matches SELECT.
 */
export async function classroomHours(
  db: Db,
  classroomId: string,
  enrollmentId: string | null,
  now: Date,
): Promise<DrillHours | null> {
  const one = enrollmentId !== null;
  if (one && !(await isStudentSeat(db, classroomId, enrollmentId))) return null;
  const v = visibleReviews(db, classroomId);
  const from = last30(now);
  const local = sql`(${v.reviewedAt} at time zone ${ZONE})`;
  const weekday = sql<number>`(extract(isodow from ${local})::int - 1)`;
  const hour = sql<number>`extract(hour from ${local})::int`;
  const rows = await db
    .select({ weekday, hour, n: one ? sql<number>`count(*)::int` : sql<number>`count(distinct ${v.userId})::int` })
    .from(v)
    .where(and(since(v, from), one ? eq(v.enrollmentId, enrollmentId) : undefined))
    .groupBy(weekday, hour);
  const days = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const r of rows) days[r.weekday]![r.hour] = r.n;
  return { since: localDate(from), offHoursShare: offHoursShare(days, isWeekdayClassHour), days };
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
  if (!(await isStudentSeat(db, classroom.id, enrollmentId))) return null;
  const v = visibleReviews(db, classroom.id);
  const week = sql<string>`to_char(date_trunc('week', ${localDay(v)}), 'YYYY-MM-DD')`;
  const rows = await db
    .select({ weekStart: week, reviews: sql<number>`count(*)::int`, recall: recallOf(v) })
    .from(v)
    .where(eq(v.enrollmentId, enrollmentId))
    .groupBy(week);

  const range = drillProgressRange({
    periodStart: classroom.periodStart,
    periodEnd: classroom.periodEnd,
    enabledOn: classroom.drillEnabledAt ? localDate(classroom.drillEnabledAt) : null,
    firstReviewOn: rows.map((r) => r.weekStart).sort()[0] ?? null,
    today: localDate(now),
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
 * The mastery on the course's concepts (#599 step 9a, ADR-081 sixth
 * addendum §9; ADR-041 §15): the mean retrievability now of the classroom's
 * reviewed cards, over its current student seats, labelled in `lang` (today's
 * classification of past reviews). One read of cards × concepts, the keys
 * and the course's list; the counting is the pure `drillMastery`
 * (`@quiz/domain`), the coverage `coverage` (the one place 7d widens). A
 * card's state is its last review's, so a card of a student who opted out
 * stands as it was before (28 (k)). A suspended card (its key no longer
 * reaches the student, `keyOpen`) is left out, as the student's view will.
 */
export async function classroomMastery(
  db: Db,
  classroom: { id: string; courseId: string },
  now: Date,
  lang: ConceptLang,
): Promise<DrillClassroomMastery> {
  const [cards, listed] = await Promise.all([
    reviewedMasteryCards(db, classroom.id, now),
    courseConceptsOf(db, classroom.courseId, lang),
  ]);
  // The labels of the concepts the cards meet outside the course's list: this
  // read names them (the teacher's "outside" bucket); the student's never does.
  const refs = new Map<string, ConceptRef>(listed.map((c) => [c.id, c]));
  const unknown = [...new Set(cards.flatMap((c) => c.conceptIds))].filter((id) => !refs.has(id));
  if (unknown.length > 0) {
    for (const row of await db.select().from(concepts).where(inArray(concepts.id, unknown))) {
      refs.set(row.id, toConceptRef(row, lang));
    }
  }

  const listedIds = listed.map((c) => c.id);
  const rollup = drillMastery(cards, listedIds, await coverage(db, listedIds), (a, b) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : byLabel(refs.get(a)!, refs.get(b)!),
  );
  const labelled = (l: MasteryLine): DrillConceptMastery => ({
    concept: l.conceptId === null ? null : refs.get(l.conceptId)!,
    cards: l.cards,
    students: l.students,
    retrievability: l.retrievability,
  });
  return {
    declared: rollup.declared,
    concepts: rollup.lines.map(labelled),
    outside: rollup.outside && {
      cards: rollup.outside.cards,
      students: rollup.outside.students,
      retrievability: rollup.outside.retrievability,
      concepts: rollup.outside.lines.map(labelled),
    },
  };
}

/**
 * Who revised what (ADR-115): the classroom's rounds of targeted revision
 * with a card answered, of its current student seats, none started after an
 * opt-out (the cut of {@link visibleReviews}). Per student: the rounds, the
 * last one and the distinct concepts; per concept: the students, the rounds
 * and the last one. Labels are the staff's — a proposed concept included, a
 * merged one under its winner, a deleted one `null`. One query over the
 * rounds, one over their concepts; never a card, a question or an answer.
 */
export async function classroomRevision(
  db: Db,
  classroom: { id: string },
  lang: ConceptLang,
): Promise<DrillClassroomRevision> {
  const rounds = await db
    .select({
      enrollmentId: enrollments.id,
      userId: drillRevisionRounds.userId,
      conceptId: drillRevisionRounds.conceptId,
      startedAt: drillRevisionRounds.startedAt,
    })
    .from(drillRevisionRounds)
    .innerJoin(
      enrollments,
      and(
        studentSeat(classroom.id),
        eq(enrollments.userId, drillRevisionRounds.userId),
        or(isNull(enrollments.drillOptedOutAt), sql`${drillRevisionRounds.startedAt} < ${enrollments.drillOptedOutAt}`),
      ),
    )
    .where(and(eq(drillRevisionRounds.classroomId, classroom.id), gt(drillRevisionRounds.cardsServed, 0)));
  const refs = await finalConceptRefs(
    db,
    [...new Set(rounds.flatMap((r) => (r.conceptId === null ? [] : [r.conceptId])))],
    lang,
  );
  type Tally = { rounds: number; lastAt: Date };
  const count = (tally: Tally | undefined, at: Date): Tally => ({
    rounds: (tally?.rounds ?? 0) + 1,
    lastAt: tally && tally.lastAt > at ? tally.lastAt : at,
  });
  const students = new Map<string, Tally & { concepts: Map<string, ConceptRef> }>();
  const byConcept = new Map<string | null, Tally & { concept: ConceptRef | null; users: Set<string> }>();
  for (const r of rounds) {
    const concept = (r.conceptId === null ? undefined : refs.get(r.conceptId)) ?? null;
    const student = students.get(r.enrollmentId);
    const concepts = student?.concepts ?? new Map<string, ConceptRef>();
    if (concept) concepts.set(concept.id, concept);
    students.set(r.enrollmentId, { ...count(student, r.startedAt), concepts });
    const line = byConcept.get(concept?.id ?? null);
    byConcept.set(concept?.id ?? null, {
      ...count(line, r.startedAt),
      concept,
      users: (line?.users ?? new Set<string>()).add(r.userId),
    });
  }
  return {
    students: [...students]
      .map(([enrollmentId, s]) => ({
        enrollmentId,
        rounds: s.rounds,
        lastAt: iso(s.lastAt),
        concepts: [...s.concepts.values()].sort(byLabel),
      }))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.enrollmentId.localeCompare(b.enrollmentId)),
    concepts: [...byConcept.values()]
      .sort((a, b) => (a.concept === null ? 1 : b.concept === null ? -1 : byLabel(a.concept, b.concept)))
      .map((l) => ({ concept: l.concept, students: l.users.size, rounds: l.rounds, lastAt: iso(l.lastAt) })),
  };
}

/**
 * Per question, the 2×2 of the classroom's stated reviews (ADR-085 §8):
 * right or wrong × sure or unsure, over the same visible reviews as the
 * activity. AGGREGATED ONLY: a question whose statements come from fewer
 * than `DRILL_CONFIDENCE_MIN_STUDENTS` distinct students with a right or
 * wrong stated answer is dropped here, so its counts never leave the
 * server. One query; the most confident errors among the wrong answers
 * first.
 */
export async function classroomConfidence(db: Db, classroomId: string): Promise<DrillQuestionConfidence[]> {
  const v = visibleReviews(db, classroomId);
  // ONE query over exactly the rows the 2×2 counts — stated, right or wrong
  // (a partial answer is in no cell) — so the students behind the threshold
  // are the students behind the cells. Grouping sets give, per question,
  // a row per (level, correctness) and one total row (`total`) carrying the
  // distinct students.
  const rows = await db
    .select({
      questionId: v.questionId,
      name: questions.internalName,
      confidence: v.confidence,
      correctness: v.correctness,
      count: sql<number>`count(*)::int`,
      students: sql<number>`count(distinct ${v.userId})::int`,
      total: sql<boolean>`grouping(${v.confidence}) = 1`,
    })
    .from(v)
    .innerJoin(questions, eq(questions.id, v.questionId))
    .where(and(isNotNull(v.confidence), ne(v.correctness, "partial")))
    .groupBy(
      sql`grouping sets ((${v.questionId}, ${questions.internalName}, ${v.confidence}, ${v.correctness}), (${v.questionId}, ${questions.internalName}))`,
    );
  return rows
    .filter((q) => q.total && drillConfidenceShown(q.students))
    .map((q) => ({
      questionId: q.questionId,
      name: q.name,
      students: q.students,
      split: drillConfidenceSplit(
        rows
          .filter((c) => !c.total && c.questionId === q.questionId)
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
