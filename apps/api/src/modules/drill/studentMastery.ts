/**
 * THE student exit for concept mastery (ADR-098, #599 step 9b; invariant 4,
 * 05 §5.7). The only code that turns a student's drill cards into concept
 * labels, and it names nothing but the concepts the classroom's course
 * declares, validated, with a band and a card count.
 *
 * What holds by construction:
 *   - the cards are the CALLER's own (`drill_cards.user_id`) and the
 *     classroom's (`classroom_id`): no other student's row is read;
 *   - only reviewed cards whose key the student may already see
 *     ({@link keyOpen}) count: an unreleased exam's concepts never reach it;
 *   - the card's own concepts, which may be proposed or outside the course,
 *     go to the pure roll-up and are never labelled, resolved or returned;
 *   - the answer holds the course's concept ref, a band and a count: no
 *     retrievability, question, card, date or confidence.
 * The caller loads the classroom through `readableClassroom` with the
 * student payload forced and passes the caller's own user id.
 */
import { and, eq, isNotNull } from "drizzle-orm";

import type { ConceptLang, StudentConceptMastery } from "@quiz/contracts";
import { studentConceptLevels, type MasteryCard } from "@quiz/domain";
import { drillRetrievability } from "@quiz/domain/drillSchedule";

import type { Db } from "../../db/client.js";
import { drillCards, questionConcepts } from "../../db/schema.js";
import { courseConceptsOf, coverage } from "../concept/service.js";
import { keyOpen } from "./review.js";

export async function studentConceptMastery(
  db: Db,
  classroom: { id: string; courseId: string; drillEnabledAt: Date | null; archivedAt: Date | null },
  userId: string,
  now: Date,
  lang: ConceptLang,
): Promise<StudentConceptMastery> {
  const none: StudentConceptMastery = { declared: false, concepts: [] };
  if (classroom.drillEnabledAt === null || classroom.archivedAt !== null) return none;
  const listed = (await courseConceptsOf(db, classroom.courseId, lang)).filter((c) => c.status === "validated");
  if (listed.length === 0) return none;

  const rows = await db
    .select({ card: drillCards, conceptId: questionConcepts.conceptId })
    .from(drillCards)
    .leftJoin(questionConcepts, eq(questionConcepts.questionId, drillCards.questionId))
    .where(
      and(eq(drillCards.classroomId, classroom.id), eq(drillCards.userId, userId), isNotNull(drillCards.lastReviewAt)),
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
  const cards: MasteryCard[] = [...found.values()]
    .filter((e) => open(e.card))
    .map((e) => ({
      id: e.card.id,
      userId,
      retrievability: drillRetrievability(e.card, now),
      conceptIds: e.conceptIds,
    }));

  const ids = listed.map((c) => c.id);
  const levels = studentConceptLevels(
    cards,
    ids.map((id) => ({ id, validated: true })),
    await coverage(db, ids),
  );
  const refs = new Map(listed.map((c) => [c.id, c]));
  return {
    declared: true,
    concepts: levels.map((l) => {
      const { id, label, qualifier } = refs.get(l.conceptId)!;
      return { concept: { id, label, qualifier }, level: l.level, cards: l.cards };
    }),
  };
}
