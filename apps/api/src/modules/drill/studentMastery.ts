/**
 * THE student exit for concept mastery (ADR-098, #599 step 9b; invariant 4,
 * 05 §5.7). The only code that turns a student's drill cards into concept
 * labels, and it names nothing but the concepts the classroom's course
 * declares, validated, with a band and a card count.
 *
 * What holds by construction:
 *   - the cards are the CALLER's own, from the one loader of the teacher's
 *     read ({@link reviewedMasteryCards}): reviewed, of this classroom, and
 *     only when their key may already reach the student;
 *   - that loader returns concept ids only, so no foreign or proposed
 *     concept row is ever loaded here: only the course's validated ones are
 *     read, and labelled;
 *   - the answer holds the course's concept ref, a band and a count: no
 *     retrievability, question, card, date or confidence.
 * The caller loads the classroom through `readableClassroom` with the
 * student payload forced and passes the caller's own user id.
 */
import type { ConceptLang, StudentConceptMastery } from "@quiz/contracts";
import { studentConceptLevels } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { courseConceptsOf, coverage } from "../concept/service.js";
import { reviewedMasteryCards } from "./masteryCards.js";

export async function studentConceptMastery(
  db: Db,
  classroom: { id: string; courseId: string; drillEnabledAt: Date | null; archivedAt: Date | null },
  userId: string,
  now: Date,
  lang: ConceptLang,
): Promise<StudentConceptMastery> {
  const none: StudentConceptMastery = { declared: false, concepts: [] };
  if (classroom.drillEnabledAt === null || classroom.archivedAt !== null) return none;
  // A proposed concept is raw teacher text: never shown, even if the course lists it.
  const listed = (await courseConceptsOf(db, classroom.courseId, lang)).filter((c) => c.status === "validated");
  if (listed.length === 0) return none;

  const ids = listed.map((c) => c.id);
  const levels = studentConceptLevels(
    await reviewedMasteryCards(db, classroom.id, now, userId),
    ids,
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
