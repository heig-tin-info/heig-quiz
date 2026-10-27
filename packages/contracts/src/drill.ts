/**
 * The drill (ADR-041, #317): the student's session and reviews, the
 * teacher's switches and reads. Shared by the API and the web app
 * (invariant 7).
 */
import { z } from "zod";

import { DRILL_CORRECTNESSES, DRILL_DEVICE_CLASSES, DRILL_LEVELS } from "@quiz/domain";

import { AnswerCoordinates } from "./common.js";
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
  /**
   * New cards held back by today's cap (`drillNewToday` of `@quiz/domain`):
   * on an empty day, what `POST /drill/session/unlock` would let in — a
   * batch of `DRILL_NEW_PER_DAY` at a time (ADR-041 §6, amendment of
   * 2026-10-27). 0 when none waits.
   */
  heldNew: z.number().int().nonnegative(),
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
  /** ADR-097: the choices of `answer` are displayed positions (`AnswerCoordinates`). */
  coordinates: AnswerCoordinates.optional(),
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
 * `GET /classrooms/:id/drill/hours[?student=]`: the classroom's grid, or one
 * student's by their enrollment id.
 */
export const DrillHoursQuery = z.object({ student: z.uuid().optional() });
export type DrillHoursQuery = z.infer<typeof DrillHoursQuery>;

/**
 * WHEN the drill is practised (ADR-041 §8, amendment of 2026-10-14): the last
 * 30 days folded on one week, Europe/Zurich time — seven rows, Monday first,
 * of 24 hours. A cell of the classroom's grid counts the distinct students
 * who reviewed in that slot; of one student's grid, their reviews.
 * `offHoursShare` (outside Monday–Friday 08–18) is in the same unit, and
 * null when the grid is empty: the one sign of an empty grid.
 */
export const DrillHours = z.object({
  /** The first local day of the window, `YYYY-MM-DD`. */
  since: z.iso.date(),
  offHoursShare: z.number().min(0).max(1).nullable(),
  days: z.array(z.array(z.number().int().nonnegative()).length(24)).length(7),
});
export type DrillHours = z.infer<typeof DrillHours>;

/**
 * One line of the teacher's mastery: the reviewed cards counted toward a
 * concept, the students behind them, and their mean retrievability now
 * (ADR-041 §15). `retrievability` is null when no card counts: "no
 * evidence", which is not a low mastery. `concept` null gathers the
 * questions without any concept.
 */
export const DrillConceptMastery = z.object({
  concept: ConceptRef.nullable(),
  cards: z.number().int(),
  students: z.number().int(),
  /** 0 to 1; null when `cards` is 0. */
  retrievability: z.number().nullable(),
});
export type DrillConceptMastery = z.infer<typeof DrillConceptMastery>;

/**
 * `GET /classrooms/:id/drill/mastery` (#599 step 9a; ADR-081 sixth addendum;
 * ADR-041 §15): the mastery on the course's concepts. Staff only; no
 * student-by-concept matrix, no minimum group size within a classroom (06,
 * question 28 (l)).
 *
 *   - `declared`: the course lists concepts. Then `concepts` has one line per
 *     listed concept, labelled in the reader's language, with its coverage
 *     (a card counts toward every listed concept that covers one of its
 *     question's concepts), and `outside` totals the cards no listed concept
 *     covers, line by concept (null when there is none).
 *   - not `declared`: `concepts` is the flat per-concept view of the
 *     classroom's reviewed cards and `outside` is null.
 *
 * Only reviewed cards that are not suspended count.
 */
export const DrillClassroomMastery = z.object({
  declared: z.boolean(),
  concepts: z.array(DrillConceptMastery),
  outside: DrillConceptMastery.omit({ concept: true })
    .extend({ retrievability: z.number(), concepts: z.array(DrillConceptMastery) })
    .nullable(),
});
export type DrillClassroomMastery = z.infer<typeof DrillClassroomMastery>;

// --- The student's own concept mastery (ADR-098, #599 step 9b) ---------------

/** The three bands of a student's level on a concept; `null` is "No data yet". */
export const DrillLevel = z.enum(DRILL_LEVELS);
export type DrillLevel = z.infer<typeof DrillLevel>;

/**
 * One course concept as a student reads it: the label in their language and
 * the qualifier, nothing of the concept's status, aliases or relations.
 */
export const StudentConceptRef = ConceptRef.pick({ id: true, label: true, qualifier: true });
export type StudentConceptRef = z.infer<typeof StudentConceptRef>;

/**
 * `GET /student/classrooms/:id/drill/mastery` (ADR-098): the caller's own
 * level on each VALIDATED concept their course declares, in the course's
 * order of concepts (label order), never ranked. `level` is a band, or
 * `null` below five reviewed cards ("No data yet"); `cards` is the number of
 * reviewed cards the level rests on. The mean retrievability itself, a
 * question, a card, a date and any other concept never leave the server.
 * `declared` is false (and `concepts` empty) when the course shows no
 * concept, or the classroom's drill is off: the page then shows nothing.
 */
export const StudentConceptMastery = z.object({
  declared: z.boolean(),
  concepts: z.array(
    z.object({
      concept: StudentConceptRef,
      level: DrillLevel.nullable(),
      cards: z.number().int(),
    }),
  ),
});
export type StudentConceptMastery = z.infer<typeof StudentConceptMastery>;

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

// --- Targeted revision (ADR-115, #897 step E) -------------------------------

/**
 * `GET /student/classrooms/:id/revision/concepts`: the concepts the caller
 * may revise in this classroom — the VALIDATED concepts its course
 * declares, labelled in their language, by label (the same list as the
 * student's concept mastery, ADR-098). `available` is false, and the list
 * empty, unless the classroom's drill is on, it is not archived, the caller
 * holds a student seat there and has not opted out. No count: whether a
 * concept has cards is learnt by starting a round.
 */
export const StudentRevisionConcepts = z.object({
  available: z.boolean(),
  concepts: z.array(StudentConceptRef),
});
export type StudentRevisionConcepts = z.infer<typeof StudentRevisionConcepts>;

/** `POST /student/classrooms/:id/revision/rounds`: one concept of {@link StudentRevisionConcepts}. */
export const RevisionRoundBody = z.object({ conceptId: z.uuid() }).strict();
export type RevisionRoundBody = z.infer<typeof RevisionRoundBody>;

/**
 * A round started: at most ten of the caller's own cards on the concept, in
 * the order to answer them. A card answered wrong at its first pass comes
 * back once later in the round (`revisionNext` of `@quiz/domain`, which
 * the client replays). No question content: that is `serve`'s.
 */
export const RevisionRound = z.object({
  id: z.uuid(),
  concept: StudentConceptRef,
  startedAt: z.iso.datetime(),
  cards: z.array(DrillSessionCard),
});
export type RevisionRound = z.infer<typeof RevisionRound>;

/** The start of a round: null, and nothing written, when no card of the caller covers the concept. */
export const RevisionRoundStart = z.object({ round: RevisionRound.nullable() });
export type RevisionRoundStart = z.infer<typeof RevisionRoundStart>;

/** `/student/revision/rounds/:id/serve/:cardId` and `…/cards/:cardId/answer`. */
export const RevisionCardParam = z.object({ id: z.uuid(), cardId: z.uuid() });
export type RevisionCardParam = z.infer<typeof RevisionCardParam>;

/**
 * `POST /student/revision/rounds/:id/serve/:cardId`: the question through the
 * one student exit, at the card's next pass (2 only after a wrong first
 * one). Serving again before the answer returns the same view.
 */
export const RevisionServed = DrillServed.extend({ pass: z.union([z.literal(1), z.literal(2)]) });
export type RevisionServed = z.infer<typeof RevisionServed>;

/**
 * `POST /student/revision/rounds/:id/cards/:cardId/answer`. Strict: no
 * confidence and no device class — a round stores neither (ADR-115).
 */
export const RevisionAnswerBody = z
  .object({
    answer: z.unknown(),
    /** ADR-097: the choices of `answer` are displayed positions (`AnswerCoordinates`). */
    coordinates: AnswerCoordinates.optional(),
  })
  .strict();
export type RevisionAnswerBody = z.infer<typeof RevisionAnswerBody>;

/**
 * The answer's correction: no rating, no due date and no time — a round
 * feeds neither FSRS nor the level, and shows no timer. `requeued` says the
 * card comes back later in the round.
 */
export const RevisionAnswerResult = z.object({
  correctness: DrillCorrectness,
  points: z.number(),
  maxPoints: z.number(),
  /** The key, through `studentSolutionView`. */
  solution: z.unknown(),
  requeued: z.boolean(),
});
export type RevisionAnswerResult = z.infer<typeof RevisionAnswerResult>;

/**
 * `GET /student/classrooms/:id/revision/rounds`: the caller's own rounds of
 * the classroom with at least one card answered, newest first — the rounds
 * their teacher counts ({@link DrillClassroomRevision}: per student, the
 * rounds, the last one's date, the concepts and the totals of the two
 * counters). `concept` is null once the concept is no longer a validated
 * concept of the course (a merge is followed to its winner).
 */
export const StudentRevisionRound = z.object({
  id: z.uuid(),
  concept: StudentConceptRef.nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  cardsServed: z.number().int(),
  cardsCorrect: z.number().int(),
});
export type StudentRevisionRound = z.infer<typeof StudentRevisionRound>;

/**
 * `GET /classrooms/:id/drill/revision`: who revised what, for the staff. The
 * rounds of the classroom's current student seats with a card answered,
 * none after an opt-out. Per student: the rounds, the last one's date, the
 * distinct concepts, and the cards served and the cards right (at their
 * first pass) over those rounds; per concept: the students, the rounds, the
 * last one (a round whose concept was deleted counts for its student only).
 * Labels in the reader's language, a merged concept under its winner. Never
 * a card, a question or an answer.
 */
export const DrillClassroomRevision = z.object({
  students: z.array(
    z.object({
      enrollmentId: z.uuid(),
      rounds: z.number().int(),
      lastAt: z.iso.datetime(),
      concepts: z.array(ConceptRef),
      cardsServed: z.number().int(),
      cardsCorrect: z.number().int(),
    }),
  ),
  concepts: z.array(
    z.object({
      concept: ConceptRef,
      students: z.number().int(),
      rounds: z.number().int(),
      lastAt: z.iso.datetime(),
    }),
  ),
});
export type DrillClassroomRevision = z.infer<typeof DrillClassroomRevision>;
