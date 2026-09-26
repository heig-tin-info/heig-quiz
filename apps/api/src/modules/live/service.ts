/**
 * The `live` module's business layer: taking an evaluation, and driving it
 * (PLAN-MVP §4.4, §4.7, §5.2, §5.3).
 *
 * This file is the entry other modules import (`import * as live from
 * "../live/service.js"`); the code lives in cohesive files beside it (audit
 * B-13), each depending only on the ones above it in this list:
 *   - `attempt.ts`: failures, deadlines, participants, attempt creation, item
 *     order, the three views, entering, the write gate, submit, the per-attempt
 *     close/reopen and the student home;
 *   - `autosave.ts`: the answer summaries, the live grader, `saveAnswer`,
 *     `markDone`, `setPosition` and the attempt journal;
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
export type { AttemptRecord, Participant } from "./attempt.js";
export {
  PREVIEW_ATTEMPT_ID,
  LiveError,
  AttemptClosedError,
  AnswerInvalid,
  RateLimited,
  RunnerDown,
  RetakeRefused,
  RetakesEnabled,
  participantOf,
  sebSeat,
  resetOwnStaffAttempt,
  enrolledCount,
  guestByToken,
  ensureGuest,
  attemptById,
  attemptOf,
  attemptsOfUser,
  ensureAttempt,
  retakeAttempt,
  gradeFinishedRetakes,
  beginAttempt,
  markPresent,
  lockedItemIds,
  attemptOrLobbyView,
  attemptView,
  previewView,
  lobbyView,
  enterEvaluation,
  isOpen,
  assertOpen,
  submitAttempt,
  closeAttempt,
  reopenAttempt,
  studentHome,
} from "./attempt.js";
export {
  summarizeAnswer,
  saveAnswer,
  markDone,
  setSkipped,
  setFlagged,
  setPosition,
  logAttemptEvent,
  countRecentEvents,
} from "./autosave.js";
export {
  runVisibleCases,
  simulateAnswer,
} from "./runs.js";
export {
  startEvaluation,
  pauseEvaluation,
  resumeEvaluation,
  closeEvaluation,
  extendTime,
} from "./control.js";
export {
  dashboardView,
  attemptInspect,
} from "./dashboard.js";
export {
  expireDueAttempts,
  autoOpenScheduled,
  autoStartFullLobbies,
  autoCloseDue,
  sweepPresence,
} from "./ticker.js";
