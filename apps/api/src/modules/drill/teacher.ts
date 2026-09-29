/**
 * The teacher's reads of the drill (ADR-041 §8, §10 items 8 and 10): each
 * student's activity and the mastery per tag, for ONE classroom — the one
 * the cards belong to (06, question 28 (j)). The route has loaded the
 * classroom through `staffAccess` before anything here runs (invariant 6).
 *
 * The opt-out rule (06, question 28 (k)): a review made after the student
 * opted out is not counted; everything before stays visible. A student who
 * opted out is served nothing, so this hides what a later rule might let
 * through, not what exists today.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { DrillActivity, DrillActivityWindow, DrillMastery } from "@quiz/contracts";
import { DRILL_TIME_ZONE } from "@quiz/domain";
import { drillRetrievability } from "@quiz/domain/drillSchedule";

import { isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { drillCards, drillReviews, enrollments, questionTags } from "../../db/schema.js";

const DAY_MS = 86_400_000;

/** The windows of the activity: the last 7 and 30 days, and everything kept. */
const WINDOWS = { last7Days: 7, last30Days: 30, all: null } as const;

/**
 * One row per student of the roster (claimed student seats): the cards of
 * the classroom, and per window the reviews, the days with a review, the
 * distinct questions reviewed and the recall rate on repeated reviews —
 * among the reviews of a card already reviewed before, those not rated
 * Again (ADR-041 §10, item 8).
 */
export async function classroomActivity(db: Db, classroomId: string, now: Date): Promise<DrillActivity> {
  const students = await db
    .select({
      userId: enrollments.userId,
      nom: enrollments.nom,
      prenom: enrollments.prenom,
      optedOutAt: enrollments.drillOptedOutAt,
    })
    .from(enrollments)
    .where(
      and(eq(enrollments.classroomId, classroomId), eq(enrollments.staff, false), isNotNull(enrollments.userId)),
    )
    .orderBy(enrollments.nom, enrollments.prenom);

  const cardCounts = new Map(
    (
      await db
        .select({ userId: drillCards.userId, n: sql<number>`count(*)::int` })
        .from(drillCards)
        .where(eq(drillCards.classroomId, classroomId))
        .groupBy(drillCards.userId)
    ).map((r) => [r.userId, r.n]),
  );

  const windows = Object.values(WINDOWS);
  const windowSql = (days: number | null, i: number) => {
    const since =
      days === null ? sql`true` : sql`reviewed_at >= ${new Date(now.getTime() - days * DAY_MS).toISOString()}::timestamptz`;
    const as = (name: string) => sql.identifier(`w${i}_${name}`);
    return sql`count(*) filter (where ${since})::int as ${as("reviews")},
      count(distinct (reviewed_at at time zone ${DRILL_TIME_ZONE})::date) filter (where ${since})::int as ${as("sessions")},
      count(distinct question_id) filter (where ${since})::int as ${as("questionsSeen")},
      count(*) filter (where ${since} and nth > 1)::int as ${as("repeated")},
      count(*) filter (where ${since} and nth > 1 and rating > 1)::int as ${as("recalled")}`;
  };
  const { rows } = await db.execute<Record<string, unknown>>(sql`
    with visible as (
      select c.user_id, c.question_id, r.rating, r.reviewed_at,
             row_number() over (partition by r.card_id order by r.reviewed_at, r.id) as nth
        from ${drillReviews} r
        join ${drillCards} c on c.id = r.card_id
        join ${enrollments} e on e.classroom_id = c.classroom_id and e.user_id = c.user_id
       where c.classroom_id = ${classroomId}
         and (e.drill_opted_out_at is null or r.reviewed_at < e.drill_opted_out_at)
    )
    select user_id, ${sql.join(windows.map(windowSql), sql`, `)}
      from visible
     group by user_id`);
  const byUser = new Map<string, DrillActivityWindow[]>();
  for (const row of rows) {
    const n = (i: number, name: keyof DrillActivityWindow) => Number(row[`w${i}_${name}`]);
    byUser.set(
      String(row["user_id"]),
      windows.map((_, i) => ({
        reviews: n(i, "reviews"),
        sessions: n(i, "sessions"),
        questionsSeen: n(i, "questionsSeen"),
        repeated: n(i, "repeated"),
        recalled: n(i, "recalled"),
      })),
    );
  }
  const empty: DrillActivityWindow = { reviews: 0, sessions: 0, questionsSeen: 0, repeated: 0, recalled: 0 };
  return {
    students: students.map((s) => {
      const w = byUser.get(s.userId!) ?? [empty, empty, empty];
      return {
        userId: s.userId!,
        nom: s.nom,
        prenom: s.prenom,
        optedOutAt: isoOrNull(s.optedOutAt),
        cards: cardCounts.get(s.userId!) ?? 0,
        last7Days: w[0]!,
        last30Days: w[1]!,
        all: w[2]!,
      };
    }),
  };
}

/**
 * Mastery per tag (ADR-041 §10, item 10): for each tag of the classroom's
 * cards, the students and cards, and the mean FSRS retrievability now of
 * the cards already reviewed. An untagged question counts in no tag.
 */
export async function classroomMastery(db: Db, classroomId: string, now: Date): Promise<DrillMastery> {
  const cards = await db.select().from(drillCards).where(eq(drillCards.classroomId, classroomId));
  if (cards.length === 0) return { tags: [] };
  const tagRows = await db
    .select()
    .from(questionTags)
    .where(inArray(questionTags.questionId, [...new Set(cards.map((c) => c.questionId))]));
  const tagsOf = new Map<string, string[]>();
  for (const t of tagRows) tagsOf.set(t.questionId, [...(tagsOf.get(t.questionId) ?? []), t.tag]);

  const acc = new Map<string, { students: Set<string>; cards: number; reviewed: number; sum: number }>();
  for (const card of cards) {
    const reviewed = card.lastReviewAt !== null;
    const r = reviewed ? drillRetrievability(card, now) : 0;
    for (const tag of tagsOf.get(card.questionId) ?? []) {
      const a = acc.get(tag) ?? { students: new Set<string>(), cards: 0, reviewed: 0, sum: 0 };
      a.students.add(card.userId);
      a.cards += 1;
      if (reviewed) {
        a.reviewed += 1;
        a.sum += r;
      }
      acc.set(tag, a);
    }
  }
  return {
    tags: [...acc.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, a]) => ({
        tag,
        students: a.students.size,
        cards: a.cards,
        reviewedCards: a.reviewed,
        meanRetrievability: a.reviewed === 0 ? null : a.sum / a.reviewed,
      })),
  };
}
