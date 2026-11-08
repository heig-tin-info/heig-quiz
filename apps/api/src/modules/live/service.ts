/**
 * The `live` module's business layer: taking an evaluation, and driving it
 * (PLAN-MVP §4.4, §4.7, §5.2, §5.3).
 *
 * This file is the entry other modules import (`import * as live from
 * "../live/service.js"`); the code lives in cohesive files beside it (audit
 * B-13), each depending only on the ones above it in this list:
 *   - `failures.ts`: the refusals and their error classes;
 *   - `deadline.ts`: the one computation of an attempt deadline;
 *   - `access.ts`: the participant, the staff seat, the attempt reads;
 *   - `guests.ts`: the guests of an anonymous poll (F-AUTH-05);
 *   - `order.ts`: the item order and the navigation lock;
 *   - `views.ts`: the attempt, preview, lobby and ready views;
 *   - `lifecycle.ts`: attempt creation, retake, start and entering;
 *   - `gates.ts`: the write gate every student write passes (§4.7);
 *   - `closing.ts`: grading at hand-in, submit, the per-attempt close/reopen;
 *   - `practice.ts`: practice after the due date (ADR-122);
 *   - `studentHome.ts`: the student home and the board `grades.ts` reads;
 *   - `dwell.ts`: the end of an interval on screen, `closeShown` (ADR-039);
 *   - `autosave.ts`: the answer summaries, the live grader, `saveAnswer`,
 *     `markDone`, `reportShown` (the position and the dwell) and the attempt
 *     journal;
 *   - `check.ts`: the per-question check of an exercise (ADR-124 §3);
 *   - `runs.ts`: running code and simulating a schematic for a student;
 *   - `control.ts`: the teacher controls (start, pause, resume, close, extend);
 *   - `dashboard.ts`: the dashboard read model and the attempt inspector;
 *   - `ticker.ts`: the ticker tasks.
 *
 * The invariants this layer exists to hold:
 *   - the SERVER owns the clock. Every function takes `now` from the caller,
 *     which took it from `app.clock`; nothing here calls `new Date()` for a
 *     decision, and a deadline is only ever computed by
 *     `@quiz/domain#attemptDeadline` (invariant 5, §10);
 *   - a student payload is only ever produced by `./studentView.ts`
 *     (invariant 4);
 *   - creating an attempt is idempotent: `INSERT … ON CONFLICT DO NOTHING`
 *     on `(evaluation_id, user_id, attempt_number)`, so two tabs share one
 *     seed and one deadline, and two retake clicks one new attempt (ADR-025);
 *   - autosave is ONE statement, never a read-modify-write: the conditional
 *     upsert of §4.7 settles the revision race in the database.
 */
export type { AttemptRecord, Participant } from "./access.js";
export {
  LiveError,
  AttemptClosedError,
  AnswerInvalid,
  RateLimited,
  RunnerDown,
  RetakeRefused,
  PracticeRefused,
  liveFailureArms,
} from "./failures.js";
export {
  participantOf,
  sebSeat,
  resetOwnStaffAttempt,
  enrolledCount,
  attemptById,
  attemptOf,
} from "./access.js";
export { guestByToken, ensureGuest, deleteGuests } from "./guests.js";
export {
  ensureAttempt,
  retakeAttempt,
  beginAttempt,
  markPresent,
  enterEvaluation,
  drawSeed,
} from "./lifecycle.js";
export {
  PREVIEW_ATTEMPT_ID,
  attemptOrLobbyView,
  attemptView,
  previewView,
  lobbyView,
} from "./views.js";
export { orderItems } from "./order.js";
export { isOpen, assertOpen } from "./gates.js";
export {
  gradeAtHandIn,
  submitAttempt,
  closeAttempt,
  reopenAttempt,
  reopenRole,
} from "./closing.js";
export { practiceEntry, startPractice } from "./practice.js";
export { studentHome } from "./studentHome.js";
export { onAttemptsEnded, type EndedAttempt } from "./dwell.js";
export { attemptOwnerName } from "./names.js";
// ADR-125 §9: the paper attempt's rows, written in the `paper` module's transaction.
export {
  announcePaperAttempt,
  insertPaperAttempt,
  paperAnswers,
  paperKey,
  type InsertedPaperAttempt,
} from "./paperAttempt.js";
export { studentGrades } from "./grades.js";
// The one student exit (invariant 4), for the modules that serve a question
// outside an attempt: the drill (ADR-041 §9).
export {
  answerFromStudent,
  answerToStudent,
  FORBIDDEN_STUDENT_KEYS,
  solutionView,
  solutionViewOf,
  studentSolutionView,
  studentSolutionViewOf,
  studentView,
  staffViews,
  studentViewOf,
  teacherPreviewView,
} from "./studentView.js";
// ADR-097: the one view of an attempt's item, for the feedback page and the preview.
export { attemptItemView, type ItemView } from "./itemView.js";
export {
  answeredBy,
  saveAnswer,
  markDone,
  setSkipped,
  setFlagged,
  reportShown,
  logAttemptEvent,
  countRecentEvents,
} from "./autosave.js";
export { checkItem } from "./check.js";
export { evaluationIncidents } from "./incidents.js";
export {
  purgeIntegrityJournal,
  purgeAbandonedIntegrityJournal,
  recordPaste,
  storesIntegrityEvent,
} from "./integrity.js";
export {
  runVisibleCases,
  simulateAnswer,
} from "./runs.js";
export {
  startEvaluation,
  pauseEvaluation,
  resumeEvaluation,
  closeEvaluation,
  tryCloseEvaluation,
  extendTime,
} from "./control.js";
export {
  dashboardView,
  attemptInspect,
  itemAnswers,
} from "./dashboard.js";
export {
  expireDueAttempts,
  autoOpenScheduled,
  autoStartFullLobbies,
  autoCloseDue,
  overdueAttempts,
  overdueEvaluations,
  sweepPresence,
} from "./ticker.js";
