/**
 * `live` route schemas (PLAN-MVP §4.4 and §4.7): taking an evaluation, and
 * driving it from the teacher's dashboard.
 *
 * Two rules shape this file:
 *   - every response that a countdown depends on carries `serverNow`, because
 *     the server owns the clock (invariant 5);
 *   - the content of a question travels as `unknown` (`student`, `answer`):
 *     its shape belongs to the question type, and the ONLY producer of a
 *     student payload is `studentView()` in the API (invariant 4).
 */
import { z } from "zod";

import {
  EvaluationMode,
  EvaluationSettings,
  EvaluationState,
  FeedbackPolicy,
} from "./evaluation.js";

export const AttemptState = z.enum(["not_started", "in_progress", "submitted", "expired"]);
export type AttemptState = z.infer<typeof AttemptState>;

export const ClosedBy = z.enum(["server", "student", "teacher"]);
export type ClosedBy = z.infer<typeof ClosedBy>;

/** What a cell of the dashboard grid shows before correction (F-DASH-01). */
export const CellStatus = z.enum(["empty", "seen", "in_progress", "done"]);
export type CellStatus = z.infer<typeof CellStatus>;

export const AttemptEventKind = z.enum([
  "visibility",
  "focus",
  "ip_change",
  "reconnect",
  "time_added",
  "paused",
  "resumed",
  "run",
]);
export type AttemptEventKind = z.infer<typeof AttemptEventKind>;

// --- Student side ---------------------------------------------------------

/**
 * One question as the student sees it. `student` is the output of
 * `type.toStudent` through `studentView()`; nothing else may produce it.
 */
export const AttemptItem = z.object({
  id: z.uuid(),
  position: z.number().int(),
  points: z.number(),
  type: z.string(),
  milestone: z.boolean(),
  student: z.unknown(),
  answer: z.unknown().nullable(),
  revision: z.number().int(),
  markedDone: z.boolean(),
  /** Navigation already forbids writing to this item (forward_only, milestones). */
  locked: z.boolean(),
});
export type AttemptItem = z.infer<typeof AttemptItem>;

export const AttemptView = z.object({
  attempt: z.object({
    id: z.uuid(),
    state: AttemptState,
    startedAt: z.iso.datetime().nullable(),
    deadlineAt: z.iso.datetime().nullable(),
    lastItemId: z.uuid().nullable(),
    serverNow: z.iso.datetime(),
    /** True for the teacher preview: nothing is persisted (PLAN-MVP §4.3). */
    preview: z.boolean(),
    /**
     * The attempt no longer accepts writes: it is over, or the evaluation is
     * not running. The player renders the same content in read mode; every
     * write would answer `410 attempt_closed` anyway (§4.7).
     */
    readOnly: z.boolean(),
  }),
  evaluation: z.object({
    id: z.uuid(),
    title: z.string(),
    mode: EvaluationMode,
    state: EvaluationState,
    settings: EvaluationSettings,
    feedbackPolicy: FeedbackPolicy,
    pausedAt: z.iso.datetime().nullable(),
    totalPoints: z.number(),
  }),
  items: z.array(AttemptItem),
});
export type AttemptView = z.infer<typeof AttemptView>;

export const LobbyView = z.object({
  evaluation: z.object({
    id: z.uuid(),
    title: z.string(),
    state: EvaluationState,
    announcedDurationS: z.number().int().nullable(),
  }),
  present: z.number().int(),
  enrolled: z.number().int(),
  timeBonusPercent: z.number().int(),
  serverNow: z.iso.datetime(),
});
export type LobbyView = z.infer<typeof LobbyView>;

/**
 * `POST /evaluations/:id/attempt` and `GET /attempts/:id` answer one of the
 * two: question content exists only once the evaluation has started, so a
 * `scheduled` or `lobby` evaluation answers the lobby, whichever route asked.
 */
export const AttemptOrLobby = z.union([
  z.object({ kind: z.literal("attempt"), view: AttemptView }),
  z.object({ kind: z.literal("lobby"), view: LobbyView }),
]);
export type AttemptOrLobby = z.infer<typeof AttemptOrLobby>;

export const AttemptStartBody = z.object({ accessCode: z.string().max(32).optional() });
export type AttemptStartBody = z.infer<typeof AttemptStartBody>;

// --- Autosave (PLAN-MVP §4.7) --------------------------------------------

export const AutosaveRequest = z.object({
  /** Validated server-side by `type.answerSchema`; never trusted here. */
  payload: z.unknown(),
  /**
   * Client-local monotonic counter; never resets for the life of the attempt.
   * Capped well under `int4`, which is what the column is: a revision the
   * database cannot store would be a 500, and one at the very top of the
   * range would freeze the item for the rest of the exam (the upsert only
   * accepts a STRICTLY greater revision).
   */
  revision: z.number().int().min(1).max(2_000_000_000),
  clientTs: z.iso.datetime(),
});
export type AutosaveRequest = z.infer<typeof AutosaveRequest>;

export const AutosaveResponse = z.object({
  /** The revision now in the database. */
  revision: z.number().int(),
  /** Present ONLY when the write was rejected as stale: the client adopts it. */
  payload: z.unknown().optional(),
  accepted: z.boolean(),
  serverNow: z.iso.datetime(),
});
export type AutosaveResponse = z.infer<typeof AutosaveResponse>;

/** The 410 body. `reason` is what the player shows the student. */
export const AttemptClosed = z.object({
  error: z.literal("attempt_closed"),
  reason: z.enum(["deadline", "submitted", "evaluation_closed", "paused"]),
  deadlineAt: z.iso.datetime().nullable(),
  serverNow: z.iso.datetime(),
});
export type AttemptClosed = z.infer<typeof AttemptClosed>;

export const MarkDoneBody = z.object({ done: z.boolean() });
export type MarkDoneBody = z.infer<typeof MarkDoneBody>;

export const MarkDoneResponse = z.object({
  done: z.boolean(),
  nextItemId: z.uuid().nullable(),
  serverNow: z.iso.datetime(),
});
export type MarkDoneResponse = z.infer<typeof MarkDoneResponse>;

export const PositionBody = z.object({ itemId: z.uuid() });
export type PositionBody = z.infer<typeof PositionBody>;

export const SubmitBody = z.object({ confirm: z.literal(true) });
export type SubmitBody = z.infer<typeof SubmitBody>;

export const SubmitResponse = z.object({
  state: AttemptState,
  submittedAt: z.iso.datetime(),
  serverNow: z.iso.datetime(),
});
export type SubmitResponse = z.infer<typeof SubmitResponse>;

export const AttemptEventBody = z.object({
  kind: AttemptEventKind,
  details: z.unknown().optional(),
});
export type AttemptEventBody = z.infer<typeof AttemptEventBody>;

/**
 * The student's Run button on a `code` question. The regions are reassembled
 * into a source server-side (invariant 14); the result comes back over SSE as
 * `runner.result`.
 */
export const RunBody = z.object({
  itemId: z.uuid(),
  regions: z.array(z.string().max(20_000)).max(20),
  stdin: z.string().max(16_000).optional(),
  /**
   * The command line of a MANUAL try, one `argv[1..]` entry per element. It
   * only applies to the free-stdin trial: a visible case runs with the
   * arguments the teacher wrote, which the client never gets to change.
   */
  args: z.array(z.string().max(200)).max(32).optional(),
});
export type RunBody = z.infer<typeof RunBody>;

export const RunAccepted = z.object({ requestId: z.uuid() });
export type RunAccepted = z.infer<typeof RunAccepted>;

/**
 * The student's own run button for a question type that builds its OWN
 * request — "Simulate" on a `circuit` (ADR-019), and whatever comes after it.
 *
 * The envelope is all this schema can say: the shape of `answer` belongs to
 * the question type, and the server parses it with that type's own
 * `answerSchema` before anything else happens (`simulateAnswer` in the live
 * service). Invariant 7 is met by the two together — an envelope validated
 * here, a payload validated by the schema the type and the client share.
 *
 * The answer to `POST /app/api/attempts/:id/simulate` is the raw
 * `RunnerOutcome` of `@quiz/core`: the client half of the type reads it, and
 * no SSE frame repeats it — the response IS the delivery.
 */
export const SimulateBody = z.object({
  itemId: z.uuid(),
  answer: z.unknown(),
});
export type SimulateBody = z.infer<typeof SimulateBody>;

// --- Student home ---------------------------------------------------------

export const EvaluationCard = z.object({
  id: z.uuid(),
  title: z.string(),
  mode: EvaluationMode,
  state: EvaluationState,
  classroomId: z.uuid(),
  classroomName: z.string(),
  courseCode: z.string(),
  opensAt: z.iso.datetime().nullable(),
  closesAt: z.iso.datetime().nullable(),
  durationS: z.number().int().nullable(),
  attemptId: z.uuid().nullable(),
  attemptState: AttemptState.nullable(),
  deadlineAt: z.iso.datetime().nullable(),
  /**
   * The Swiss grade, once the results are released (WP6). `null` everywhere
   * else: an evaluation still running has no grade to show, and an unreleased
   * one must not leak the one it would have.
   */
  grade: z.number().nullable(),
});
export type EvaluationCard = z.infer<typeof EvaluationCard>;

export const StudentHome = z.object({
  open: z.array(EvaluationCard),
  upcoming: z.array(EvaluationCard),
  past: z.array(EvaluationCard),
  serverNow: z.iso.datetime(),
});
export type StudentHome = z.infer<typeof StudentHome>;

// --- Teacher side ---------------------------------------------------------

export const DashboardCell = z.object({
  itemId: z.uuid(),
  status: CellStatus,
  verdict: z.enum(["correct", "partial", "wrong", "pending"]).nullable(),
  points: z.number().nullable(),
  revision: z.number().int(),
  /** Only when `?includeAnswers=1` (F-DASH-02). */
  summary: z.string().nullable(),
});
export type DashboardCell = z.infer<typeof DashboardCell>;

export const DashboardRow = z.object({
  attemptId: z.uuid().nullable(),
  userId: z.uuid(),
  displayName: z.string(),
  /**
   * The row belongs to a STAFF seat: a teacher walking their own quiz as a
   * student (ADR-018). It is shown — that is the point of the walk — and it
   * counts in no total: not in the completion of a question, not in its
   * success rate, not in the class statistics.
   */
  staff: z.boolean(),
  /** Stable per-row pseudonym when names are hidden (F-DASH-02, decision D20). */
  pseudonym: z.string(),
  state: AttemptState,
  online: z.boolean(),
  lastSeenAt: z.iso.datetime().nullable(),
  deadlineAt: z.iso.datetime().nullable(),
  timeBonusPercent: z.number().int(),
  points: z.number().nullable(),
  maxPoints: z.number(),
  cells: z.array(DashboardCell),
});
export type DashboardRow = z.infer<typeof DashboardRow>;

export const DashboardView = z.object({
  evaluation: z.object({
    id: z.uuid(),
    state: EvaluationState,
    startedAt: z.iso.datetime().nullable(),
    pausedAt: z.iso.datetime().nullable(),
    closesAt: z.iso.datetime().nullable(),
    serverNow: z.iso.datetime(),
  }),
  items: z.array(
    z.object({
      id: z.uuid(),
      position: z.number().int(),
      points: z.number(),
      type: z.string(),
      internalName: z.string(),
      milestone: z.boolean(),
    }),
  ),
  rows: z.array(DashboardRow),
  totals: z.array(
    z.object({
      itemId: z.uuid(),
      completion: z.number(),
      successRate: z.number().nullable(),
    }),
  ),
});
export type DashboardView = z.infer<typeof DashboardView>;

export const DashboardQuery = z.object({
  includeAnswers: z
    .union([z.string(), z.boolean()])
    .default(false)
    .transform((v) => v === true || v === "1" || v === "true"),
});
export type DashboardQuery = z.infer<typeof DashboardQuery>;

/**
 * `DELETE /evaluations/:id/attempt` — a teacher throws away their OWN staff
 * test attempt so they can walk the quiz again (ADR-018). `deleted` is false
 * when there was nothing to remove, which is a success and not a 404.
 */
export const ResetAttemptResponse = z.object({ deleted: z.boolean() });
export type ResetAttemptResponse = z.infer<typeof ResetAttemptResponse>;

export const StartBody = z.object({ confirm: z.literal(true) });
export type StartBody = z.infer<typeof StartBody>;

/** F-LIVE-11: +1, +5 or +10 minutes, to everybody or to one student. */
export const ExtendBody = z
  .object({
    minutes: z.union([z.literal(1), z.literal(5), z.literal(10)]),
    scope: z.enum(["all", "attempt"]).default("all"),
    attemptId: z.uuid().optional(),
  })
  .refine((b) => b.scope === "all" || b.attemptId !== undefined, {
    message: "attemptId is required when scope is 'attempt'",
  });
export type ExtendBody = z.infer<typeof ExtendBody>;

export const ExtendResponse = z.object({
  updated: z.number().int(),
  serverNow: z.iso.datetime(),
});
export type ExtendResponse = z.infer<typeof ExtendResponse>;

/** `/evaluations/:id/attempts/:attemptId` */
export const AttemptParam = z.object({ id: z.uuid(), attemptId: z.uuid() });
export type AttemptParam = z.infer<typeof AttemptParam>;

/** `/attempts/:id/answers/:itemId` */
export const AnswerParam = z.object({ id: z.uuid(), itemId: z.uuid() });
export type AnswerParam = z.infer<typeof AnswerParam>;

/** F-DASH-05: one cell opened in read mode. */
export const AttemptInspect = z.object({
  attempt: z.object({
    id: z.uuid(),
    userId: z.uuid(),
    displayName: z.string(),
    pseudonym: z.string(),
    state: AttemptState,
    startedAt: z.iso.datetime().nullable(),
    deadlineAt: z.iso.datetime().nullable(),
    submittedAt: z.iso.datetime().nullable(),
  }),
  items: z.array(
    z.object({
      item: z.object({
        id: z.uuid(),
        position: z.number().int(),
        points: z.number(),
        type: z.string(),
        internalName: z.string(),
      }),
      studentConfig: z.unknown(),
      answer: z.unknown().nullable(),
      revision: z.number().int(),
      markedDone: z.boolean(),
      solution: z.unknown(),
    }),
  ),
  events: z.array(
    z.object({
      kind: AttemptEventKind,
      at: z.iso.datetime(),
      details: z.unknown().nullable(),
    }),
  ),
  serverNow: z.iso.datetime(),
});
export type AttemptInspect = z.infer<typeof AttemptInspect>;
