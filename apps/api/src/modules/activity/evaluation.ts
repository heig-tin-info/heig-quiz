/**
 * The evaluation kind of activity (exam, exercise, and poll as a mode,
 * ADR-014). An adapter, not new behaviour: each method is what the
 * evaluation module already answers. It lives here rather than in the
 * evaluation module so that the later members (the student's cards from
 * `live`, the gradebook entries from `results`) need no import the
 * evaluation module does not already make.
 */
import { listActivities } from "../evaluation/service.js";
import { ownEvaluationAccess } from "../guards.js";
import type { ActivityKind } from "./kind.js";

export const evaluationActivity: ActivityKind<"evaluation"> = {
  kind: "evaluation",
  listForTeacher: (db, caller, now) => listActivities(db, ownEvaluationAccess(caller), now),
};
