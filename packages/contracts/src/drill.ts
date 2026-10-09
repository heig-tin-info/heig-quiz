/**
 * The drill (ADR-041, #317): the student's session and reviews, the
 * teacher's switches and reads. Shared by the API and the web app
 * (invariant 7).
 */
import { z } from "zod";

import { DRILL_CORRECTNESSES, DRILL_DEVICE_CLASSES } from "@quiz/domain";

import { ConceptRef } from "./concept.js";

/** The pointer a review was made with (`useCoarsePointer`): `coarse` is a phone or a tablet. */
export const DrillDeviceClass = z.enum(DRILL_DEVICE_CLASSES);
export type DrillDeviceClass = z.infer<typeof DrillDeviceClass>;

export const DrillCorrectness = z.enum(DRILL_CORRECTNESSES);
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

/**
 * How sure the student says they are, stated before the correction (ADR-085):
 * 0 No idea, 1 Unsure, 2 Fairly sure, 3 Sure, 4 Certain.
 */
export const DrillConfidence = z.number().int().min(0).max(4);
export type DrillConfidence = z.infer<typeof DrillConfidence>;

/**
 * `POST /drill/cards/:id/answer`. The answer is parsed by the type's own
 * schema. `confidence` is optional — absent or null when the student skipped
 * it — stored beside the review and never read by its rating or its schedule
 * (ADR-085 §2).
 */
export const DrillAnswerBody = z.object({
  answer: z.unknown(),
  deviceClass: DrillDeviceClass,
  confidence: DrillConfidence.nullable().optional(),
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

// --- Teacher's view (slice 4) ----------------------------------------------

/**
 * Repeated reviews and those recalled in a window: the recall rate is
 * `recalled / repeated` (`drillRecallRate`), none when nothing was repeated.
 * A card's first drill review is left out (ADR-041 §10, item 8).
 */
export const DrillRecall = z.object({
  repeated: z.number().int(),
  recalled: z.number().int(),
});
export type DrillRecall = z.infer<typeof DrillRecall>;

/**
 * `GET /classrooms/:id/drill/activity`: one row per student seat of the
 * classroom (ADR-041 §8). Only the cards met first in this classroom count
 * (06, question 28 (j)); after an opt-out nothing more is counted, what came
 * before stays (28 (k)), and the opt-out itself is shown with its date
 * (§13, item 5). The windows are rolling, from the server's now.
 */
export const DrillStudentActivity = z.object({
  enrollmentId: z.uuid(),
  nom: z.string(),
  prenom: z.string(),
  /** Cards reviewed at least once. */
  questionsSeen: z.number().int(),
  /** Distinct days (Europe/Zurich) with a review. */
  sessions: z.number().int(),
  lastReviewAt: z.iso.datetime().nullable(),
  reviews: z.object({ last30: z.number().int(), all: z.number().int() }),
  recall: z.object({
    last30: DrillRecall,
    /** Days 30 to 60 before now: what the trend compares the last 30 days with. */
    previous30: DrillRecall,
    all: DrillRecall,
  }),
  optedOutAt: z.iso.datetime().nullable(),
});
export type DrillStudentActivity = z.infer<typeof DrillStudentActivity>;

/** `GET /classrooms/:id/drill/progress?student=`: one student's weeks, by their enrollment id. */
export const DrillProgressQuery = z.object({ student: z.uuid() });
export type DrillProgressQuery = z.infer<typeof DrillProgressQuery>;

export const DrillWeek = z.object({
  /** The Monday of the week (Europe/Zurich), `YYYY-MM-DD`. */
  weekStart: z.iso.date(),
  reviews: z.number().int(),
  recall: DrillRecall,
});
export type DrillWeek = z.infer<typeof DrillWeek>;

/**
 * One student's weeks over the classroom's dated period up to today — or,
 * without one, from the drill's start — empty weeks included, so the trend
 * reads.
 */
export const DrillProgress = z.object({ weeks: z.array(DrillWeek) });
export type DrillProgress = z.infer<typeof DrillProgress>;

/**
 * `GET /classrooms/:id/drill/mastery`: per concept, the mean retrievability
 * now of the classroom's reviewed cards (ADR-041 §10, item 10; ADR-081 third
 * addendum §8: today's classification, labelled in the reader's language).
 * No minimum group size within a classroom (06, question 28 (l)). `concept`
 * null gathers the questions without any concept.
 */
export const DrillConceptMastery = z.object({
  concept: ConceptRef.nullable(),
  cards: z.number().int(),
  students: z.number().int(),
  /** 0 to 1. */
  retrievability: z.number(),
});
export type DrillConceptMastery = z.infer<typeof DrillConceptMastery>;

// --- Confidence (ADR-085 §8, part 2 of issue #453) ---------------------------

/**
 * `GET /drill/calibration`: the student's own calibration, one entry per
 * level of confidence, lowest first, all five present. `answers` counts the
 * student's reviews stated at that level, in every classroom; `right` those
 * that were right (a partial answer is not). The rate is the client's to
 * show through `drillCalibrationRate`, which says "not enough answers"
 * below its threshold.
 */
export const DrillCalibrationLevel = z.object({
  confidence: DrillConfidence,
  answers: z.number().int(),
  right: z.number().int(),
});
export type DrillCalibrationLevel = z.infer<typeof DrillCalibrationLevel>;

/** Right or wrong × sure (Sure, Certain) or unsure (No idea to Fairly sure); partial answers left out. */
export const DrillConfidenceSplit = z.object({
  rightSure: z.number().int(),
  rightUnsure: z.number().int(),
  wrongSure: z.number().int(),
  wrongUnsure: z.number().int(),
});
export type DrillConfidenceSplit = z.infer<typeof DrillConfidenceSplit>;

/**
 * `GET /classrooms/:id/drill/confidence`: per question of the classroom's
 * cards, the 2×2 of the stated reviews of its student seats, an opt-out
 * cutting as in the activity. AGGREGATED ONLY, never one student's
 * statement; a question is absent unless `students` — the distinct students
 * behind its cells, who stated a confidence with a right or wrong answer —
 * reaches `DRILL_CONFIDENCE_MIN_STUDENTS`,
 * a cut made on the server so a smaller group never travels.
 */
export const DrillQuestionConfidence = z.object({
  questionId: z.uuid(),
  /** The question's internal name: a staff read. */
  name: z.string(),
  students: z.number().int(),
  split: DrillConfidenceSplit,
});
export type DrillQuestionConfidence = z.infer<typeof DrillQuestionConfidence>;
