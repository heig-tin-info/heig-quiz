/**
 * The `drill` module's business layer (ADR-041, #317): spaced practice over
 * the questions a student met in their evaluations, scheduled by FSRS.
 *
 * This file is the entry other modules import (`import * as drill from
 * "../drill/service.js"`); the code lives beside it:
 *   - `lifecycle.ts`: the cards created at a release or a hand-in, removed by
 *     the teacher, purged after five years, and the key fingerprint;
 *
 * The module owns `drill_cards` and `drill_reviews`. The switches it reads
 * belong to their modules and are written through their services:
 * `classrooms.drill_enabled_at` and `enrollments.drill_opted_out_at`
 * (`org`), `settings.allowDrill` (`evaluation`).
 */
export {
  DRILL_RETENTION,
  bestEffort,
  cardsAtHandIn,
  cardsAtRelease,
  evaluationCardCount,
  keyHashOf,
  purgeExpiredDrill,
  removeEvaluationCards,
} from "./lifecycle.js";
