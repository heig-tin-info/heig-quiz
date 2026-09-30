/**
 * The evaluation kind of activity (exam, exercise, and poll as a mode,
 * ADR-014). An adapter, not new behaviour: each method is what the
 * evaluation module already answers. It lives here rather than in the
 * evaluation module so that the later members (the student's cards from
 * `live`, the gradebook entries from `results`) need no import the
 * evaluation module does not already make.
 */
import type { EvaluationCard } from "@quiz/contracts";

import { listActivities } from "../evaluation/service.js";
import { ownEvaluationAccess } from "../guards.js";
import { studentHome } from "../live/service.js";
import type { ActivityKind, CardOf } from "./kind.js";

const tagged = (cards: EvaluationCard[]): CardOf<"evaluation">[] =>
  cards.map((card) => ({ kind: "evaluation", ...card }));

export const evaluationActivity: ActivityKind<"evaluation"> = {
  kind: "evaluation",
  listForTeacher: (db, caller, now) => listActivities(db, ownEvaluationAccess(caller), now),
  /** The student home narrowed to the classroom: the same rows, sorted the same way. */
  async studentCards(db, caller, classroomId, now) {
    const home = await studentHome(db, caller.id, now, classroomId);
    return {
      polls: home.polls,
      open: tagged(home.open),
      upcoming: tagged(home.upcoming),
      past: tagged(home.past),
    };
  },
};
