/**
 * The `drill` module's business layer (ADR-041, #317): spaced practice over
 * the questions a student met in their evaluations, scheduled by FSRS.
 *
 * This file is the entry other modules import (`import * as drill from
 * "../drill/service.js"`); the code lives beside it:
 *   - `lifecycle.ts`: the cards created at a release or a hand-in, removed by
 *     the teacher, purged after five years; the key fingerprint and the
 *     eligibility of a question;
 *   - `serving.ts`: what serving a card takes, shared by the session and
 *     targeted revision — the active cards, their key, the student view and
 *     the grading of an answer;
 *   - `review.ts`: the student's session, the served card, its time on
 *     screen and the review;
 *   - `revision.ts`: targeted revision by concept (ADR-115), rounds of extra
 *     practice outside FSRS and the level;
 *   - `studentMastery.ts`: the student's own level per course concept (ADR-098);
 *   - `teacher.ts`: the teacher's reads of a classroom — each student's
 *     activity, the weekly progression, the mastery per concept, the confidence
 *     per question (aggregated only), who revised which concept.
 *
 * The module owns `drill_cards`, `drill_reviews`, `drill_new_unlocks`,
 * `drill_revision_rounds` and `drill_revision_answers`. The switches it reads
 * belong to their modules and are written through their services:
 * `classrooms.drill_enabled_at` and `enrollments.drill_opted_out_at`
 * (`org`), `settings.allowDrill` (`evaluation`). It depends on `live` (the
 * student exit, the seed, the end of an attempt), never the reverse.
 */
import { onAttemptsEnded } from "../live/service.js";
import { onResultsReleased } from "../results/service.js";
import { cardsAtHandIn, cardsAtRelease } from "./lifecycle.js";

/**
 * ADR-041 §1: an exam enters the drill at the release of its results, an
 * exercise at the hand-in. `results` and `live` call their listeners after
 * the commit and log one that throws; neither imports this module, the
 * dependency goes one way.
 *
 * Called EXPLICITLY where the application is built (`buildApp`), and by the
 * database test helper so that every db test runs the production wiring —
 * never as a side effect of an import. Idempotent: a listener is a set
 * member, so a second call adds nothing.
 */
export function registerDrillHooks(): void {
  onResultsReleased(cardsAtRelease);
  onAttemptsEnded(cardsAtHandIn);
}

export {
  backfillClassroom,
  evaluationCardCount,
  purgeExpiredDrill,
  removeEvaluationCards,
} from "./lifecycle.js";
export {
  answerCard,
  drillSession,
  reportShown,
  serveCard,
  studentCalibration,
  studentDrillClassrooms,
  unlockNewCards,
} from "./review.js";
export {
  answerRound,
  endRound,
  serveRound,
  startRound,
  studentRevisionConcepts,
  studentRevisionRounds,
} from "./revision.js";
export { DrillError } from "./serving.js";
export {
  classroomActivity,
  classroomConfidence,
  classroomHours,
  classroomMastery,
  classroomProgress,
  classroomRevision,
} from "./teacher.js";
export { studentConceptMastery } from "./studentMastery.js";
