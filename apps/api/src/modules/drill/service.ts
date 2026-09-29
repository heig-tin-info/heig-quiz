/**
 * The `drill` module's business layer (ADR-041, #317): spaced practice over
 * the questions a student met in their evaluations, scheduled by FSRS.
 *
 * This file is the entry other modules import (`import * as drill from
 * "../drill/service.js"`); the code lives beside it:
 *   - `lifecycle.ts`: the cards created at a release or a hand-in, removed by
 *     the teacher, purged after five years; the key fingerprint and the
 *     eligibility of a question;
 *   - `review.ts`: the student's session, the served card, its time on
 *     screen and the review.
 *
 * The module owns `drill_cards` and `drill_reviews`. The switches it reads
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
  DRILL_RETENTION,
  cardsAtHandIn,
  cardsAtRelease,
  evaluationCardCount,
  isDrillableQuestion,
  keyHashOf,
  purgeExpiredDrill,
  removeEvaluationCards,
} from "./lifecycle.js";
export {
  DrillError,
  DrillCardNotFound,
  DrillNotServed,
  DrillAnswerInvalid,
  answerCard,
  drillSession,
  reportShown,
  serveCard,
  studentDrillClassrooms,
} from "./review.js";
