/**
 * The drill (ADR-041, #317): the student's session and reviews, the
 * teacher's switches and reads. Shared by the API and the web app
 * (invariant 7).
 */
import { z } from "zod";

/** The pointer a review was made with (`useCoarsePointer`): `coarse` is a phone or a tablet. */
export const DrillDeviceClass = z.enum(["coarse", "fine"]);
export type DrillDeviceClass = z.infer<typeof DrillDeviceClass>;

export const DrillCorrectness = z.enum(["right", "partial", "wrong"]);
export type DrillCorrectness = z.infer<typeof DrillCorrectness>;

// --- Student ---------------------------------------------------------------

/** `GET /drill/session?device=`: the reference times are those of that device class. */
export const DrillSessionQuery = z.object({ device: DrillDeviceClass.default("fine") });
export type DrillSessionQuery = z.infer<typeof DrillSessionQuery>;

/** One card of today's session, in the order to review it. No question content: that is `serve`'s. */
export const DrillSessionCard = z.object({
  id: z.uuid(),
  type: z.string(),
  courseCode: z.string(),
  courseName: z.string(),
  /** Never reviewed in the drill. */
  isNew: z.boolean(),
});
export type DrillSessionCard = z.infer<typeof DrillSessionCard>;

export const DrillSession = z.object({
  cards: z.array(DrillSessionCard),
  /** The target length of the session, in ms (ADR-041 §6). */
  budgetMs: z.number().int(),
  /**
   * When something is next due, for an empty day ("nothing to review today",
   * 06, question 28 (b)); null when the student has no card at all.
   */
  nextDueAt: z.iso.datetime().nullable(),
});
export type DrillSession = z.infer<typeof DrillSession>;

/**
 * A classroom of the student whose drill is on: what the tab lists, with the
 * opt-out switch and the notice that the teacher sees the activity (ADR-041 §8).
 */
export const DrillClassroom = z.object({
  classroomId: z.uuid(),
  classroomName: z.string(),
  courseCode: z.string(),
  courseName: z.string(),
  optedOutAt: z.iso.datetime().nullable(),
});
export type DrillClassroom = z.infer<typeof DrillClassroom>;

/** `PUT /drill/classrooms/:id/opt-out`. */
export const DrillOptOutBody = z.object({ optedOut: z.boolean() });
export type DrillOptOutBody = z.infer<typeof DrillOptOutBody>;

/**
 * `POST /drill/cards/:id/serve`: the question, through the one student exit
 * (`studentView`, invariant 4), with a seed of its own. Serving again before
 * answering returns the same view.
 */
export const DrillServed = z.object({
  cardId: z.uuid(),
  type: z.string(),
  student: z.unknown(),
});
export type DrillServed = z.infer<typeof DrillServed>;

/**
 * `POST /drill/cards/:id/shown`: the question is on screen from now (`true`)
 * or no longer (`false`, the tab hidden). The server sums the time between,
 * on its own clock (ADR-041 §4, ADR-039).
 */
export const DrillShownBody = z.object({ shown: z.boolean() });
export type DrillShownBody = z.infer<typeof DrillShownBody>;

/** `POST /drill/cards/:id/answer`. The answer is parsed by the type's own schema. */
export const DrillAnswerBody = z.object({
  answer: z.unknown(),
  deviceClass: DrillDeviceClass,
});
export type DrillAnswerBody = z.infer<typeof DrillAnswerBody>;

export const DrillReviewResult = z.object({
  correctness: DrillCorrectness,
  /** FSRS rating, 1 Again to 4 Easy, computed, never asked (F-DRILL-02). */
  rating: z.number().int().min(1).max(4),
  points: z.number(),
  maxPoints: z.number(),
  /** The active time the server summed. */
  activeMs: z.number().int(),
  /** The reference it was compared with; null when there was none (rated on correctness alone). */
  referenceMs: z.number().int().nullable(),
  dueAt: z.iso.datetime(),
  /** The key, through `studentSolutionView` (06, question 28 (h)). */
  solution: z.unknown(),
});
export type DrillReviewResult = z.infer<typeof DrillReviewResult>;

// --- Teacher ---------------------------------------------------------------

/** The answer of `PUT /classrooms/:id/drill`. */
export const DrillClassroomSettings = z.object({
  enabled: z.boolean(),
  enabledAt: z.iso.datetime().nullable(),
  /** The cards the past evaluations gave rise to when the drill was enabled (ADR-041 §13); 0 when disabled. */
  cardsCreated: z.number().int(),
});
export type DrillClassroomSettings = z.infer<typeof DrillClassroomSettings>;

export const DrillClassroomBody = z.object({ enabled: z.boolean() });
export type DrillClassroomBody = z.infer<typeof DrillClassroomBody>;

/**
 * `PUT /evaluations/:id/drill`, the one writer of `settings.allowDrill`:
 * editable until the release (ADR-041 §10, item 3).
 */
export const EvaluationDrillBody = z.object({ allowDrill: z.boolean() });
export type EvaluationDrillBody = z.infer<typeof EvaluationDrillBody>;

export const EvaluationDrill = z.object({
  allowDrill: z.boolean(),
  /** The cards this evaluation gave rise to. */
  cards: z.number().int(),
});
export type EvaluationDrill = z.infer<typeof EvaluationDrill>;

/** `DELETE /evaluations/:id/drill/cards`: "Remove these questions from the drill". */
export const DrillCardsRemoved = z.object({ removed: z.number().int() });
export type DrillCardsRemoved = z.infer<typeof DrillCardsRemoved>;
