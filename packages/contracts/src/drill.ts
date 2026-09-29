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

/** `GET|PUT /classrooms/:id/drill`. */
export const DrillClassroomSettings = z.object({
  enabled: z.boolean(),
  enabledAt: z.iso.datetime().nullable(),
});
export type DrillClassroomSettings = z.infer<typeof DrillClassroomSettings>;

export const DrillClassroomBody = z.object({ enabled: z.boolean() });
export type DrillClassroomBody = z.infer<typeof DrillClassroomBody>;

/** `PUT /evaluations/:id/drill`: editable until the release (ADR-041 §10, item 3). */
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

/**
 * One time window of a student's activity. The recall rate of ADR-041 §10
 * (item 8) is `recalled / repeated`: among the reviews of a question the
 * student had already drilled, the share not rated Again.
 */
export const DrillActivityWindow = z.object({
  reviews: z.number().int(),
  /** Days with at least one review (Zurich calendar). */
  sessions: z.number().int(),
  /** Distinct questions reviewed. */
  questionsSeen: z.number().int(),
  repeated: z.number().int(),
  recalled: z.number().int(),
});
export type DrillActivityWindow = z.infer<typeof DrillActivityWindow>;

export const DrillStudentActivity = z.object({
  userId: z.uuid(),
  nom: z.string(),
  prenom: z.string(),
  /** Activity after this instant is not shown (06, question 28 (k)). */
  optedOutAt: z.iso.datetime().nullable(),
  cards: z.number().int(),
  last7Days: DrillActivityWindow,
  last30Days: DrillActivityWindow,
  all: DrillActivityWindow,
});
export type DrillStudentActivity = z.infer<typeof DrillStudentActivity>;

/** `GET /classrooms/:id/drill/activity`: one row per student of the roster. */
export const DrillActivity = z.object({ students: z.array(DrillStudentActivity) });
export type DrillActivity = z.infer<typeof DrillActivity>;

/**
 * `GET /classrooms/:id/drill/mastery`: per tag, the mean retrievability
 * (FSRS) of the cards already reviewed, now (ADR-041 §10, item 10).
 */
export const DrillTagMastery = z.object({
  tag: z.string(),
  students: z.number().int(),
  cards: z.number().int(),
  reviewedCards: z.number().int(),
  /** 0 to 1; null when no card of the tag was reviewed yet. */
  meanRetrievability: z.number().nullable(),
});
export type DrillTagMastery = z.infer<typeof DrillTagMastery>;

export const DrillMastery = z.object({ tags: z.array(DrillTagMastery) });
export type DrillMastery = z.infer<typeof DrillMastery>;
