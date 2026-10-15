/**
 * The ONE loader of the cards a mastery counts (#599 step 9, ADR-081 sixth
 * addendum §9, ADR-098): the classroom's reviewed cards of its current
 * student seats, each with the concept ids of its question as they stand
 * now, its retrievability at `now`, and only when its key may already reach
 * the student ({@link keyOpen}: a suspended card is out). The teacher's read
 * passes no `userId`; the student's passes their own, so no other student's
 * row can enter it.
 *
 * It returns ids only: neither a concept row nor a question's content is
 * loaded, so a caller that must not name a concept never holds one.
 */
import { and, eq, isNotNull } from "drizzle-orm";

import type { MasteryCard } from "@quiz/domain";
import { drillRetrievability } from "@quiz/domain/drillSchedule";

import type { Db } from "../../db/client.js";
import { drillCards, enrollments, questionConcepts } from "../../db/schema.js";
import { keyOpen } from "./serving.js";

export async function reviewedMasteryCards(
  db: Db,
  classroomId: string,
  now: Date,
  userId?: string,
): Promise<MasteryCard[]> {
  const rows = await db
    .select({ card: drillCards, conceptId: questionConcepts.conceptId })
    .from(drillCards)
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.classroomId, classroomId),
        eq(enrollments.staff, false),
        eq(enrollments.userId, drillCards.userId),
      ),
    )
    .leftJoin(questionConcepts, eq(questionConcepts.questionId, drillCards.questionId))
    .where(
      and(
        eq(drillCards.classroomId, classroomId),
        isNotNull(drillCards.lastReviewAt),
        userId === undefined ? undefined : eq(drillCards.userId, userId),
      ),
    );
  const found = new Map<string, { card: (typeof rows)[number]["card"]; conceptIds: string[] }>();
  for (const { card, conceptId } of rows) {
    const entry = found.get(card.id) ?? { card, conceptIds: [] };
    if (conceptId) entry.conceptIds.push(conceptId);
    found.set(card.id, entry);
  }
  const open = await keyOpen(
    db,
    [...found.values()].map((e) => e.card),
  );
  return [...found.values()]
    .filter((e) => open(e.card))
    .map((e) => ({
      id: e.card.id,
      userId: e.card.userId,
      retrievability: drillRetrievability(e.card, now),
      conceptIds: e.conceptIds,
    }));
}
