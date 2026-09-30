/**
 * The evaluation kind of activity (exam, exercise, and poll as a mode,
 * ADR-014). An adapter, not new behaviour: every method is what the
 * evaluation, live and results modules already answer, narrowed to what the
 * interface asks. It lives here rather than in the evaluation module because
 * an evaluation's student side belongs to `live` and its results to
 * `results`, which the evaluation module does not import.
 */
import type { ResultCard, StudentHome } from "@quiz/contracts";

import { ownEvaluationAccess } from "../guards.js";
import { listActivities, listClassroomActivities } from "../evaluation/service.js";
import { studentHome } from "../live/service.js";
import { studentResultCards } from "../results/service.js";
import type { ActivityKind } from "./kind.js";

/** The student home's sections, for one classroom (`serverNow` is the page's, not the kind's). */
export type EvaluationCards = Omit<StudentHome, "serverNow">;

const inClassroom =
  (classroomId: string) =>
  <T extends { classroomId: string }>(card: T): boolean =>
    card.classroomId === classroomId;

export const evaluationActivity: ActivityKind<"evaluation", EvaluationCards, ResultCard> = {
  kind: "evaluation",

  listForTeacher: (db, caller, now) => listActivities(db, ownEvaluationAccess(caller), now),

  listForClassroom: (db, classroomId) => listClassroomActivities(db, classroomId),

  // The student home already reads every card through the student's own
  // claimed seats (no draft, no one else's attempt); a classroom is a filter
  // of it. M5-01 may push the filter into the query if a student's page
  // proves slow.
  async studentCards(db, userId, classroomId, now) {
    const home = await studentHome(db, userId, now);
    const mine = inClassroom(classroomId);
    return {
      polls: home.polls.filter(mine),
      open: home.open.filter(mine),
      upcoming: home.upcoming.filter(mine),
      past: home.past.filter(mine),
    };
  },

  async gradebookEntries(db, userId, classroomId) {
    return (await studentResultCards(db, userId)).filter(inClassroom(classroomId));
  },
};
