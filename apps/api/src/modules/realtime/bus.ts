/**
 * THE publication seam (PLAN-MVP §10: "never publish an event directly").
 *
 * Every live event of the platform is built here, addressed to its topics
 * here, and coalesced here. A module calls one of the named functions below;
 * it never touches `events.ts` and never decides an audience by itself.
 *
 * Audience is the second half of the routing table of §4.8: `dashboard.*` is
 * published with `audience: "staff"`, and the SSE connection drops it for a
 * student even when the student watches the same `evaluation:<id>` topic (a
 * student in the lobby legitimately receives `lobby.count` on it).
 */
import type {
  AttemptClosedEvent,
  AttemptDeadlineEvent,
  AttemptState,
  CellStatus,
  ClosedBy,
  DashboardAttemptEvent,
  DashboardCellEvent,
  DashboardPresenceEvent,
  EvaluationState,
  GradingProgressEvent,
  LobbyCountEvent,
  PollTallyEvent,
  RunnerResultEvent,
  ServerEvent,
  Topic,
  Verdict,
} from "@quiz/contracts";

import { iso, isoOrNull } from "../../clock.js";
import { isOwnedPoll } from "../../db/evaluation.js";
import {
  publish as publishHint,
  publishData,
  type Audience,
  type AppNotice,
  type EventType,
} from "../../events.js";
import { Coalescer } from "./coalesce.js";

/** PLAN-MVP §4.8 routing table. */
const CELL_WINDOW_MS = 250;
const PRESENCE_WINDOW_MS = 1000;
/** docs/spec/05 §5.4: the poll aggregate goes out at most twice a second. */
const POLL_WINDOW_MS = 500;

export const evaluationTopic = (id: string): Topic => `evaluation:${id}`;
const attemptTopic = (id: string): Topic => `attempt:${id}`;
export const userTopic = (id: string): Topic => `user:${id}`;
const teacherTopic = (id: string): Topic => `teacher:${id}`;

/**
 * Where an evaluation's listing lives, for the refresh hints: its
 * classroom's topic — or, for an anonymous poll that belongs to no
 * classroom (ADR-014, addendum 2026-09-27), its owner's own `teacher:` topic,
 * which is where their list of recent polls listens. A template (ADR-031)
 * is never run, so nothing that hints here ever holds one.
 */
export function homeTopic(evaluation: {
  id: string;
  classroomId: string | null;
  courseId: string | null;
  mode: string;
  createdBy: string | null;
}): Topic[] {
  if (evaluation.classroomId !== null) return [`classroom:${evaluation.classroomId}`];
  if (!isOwnedPoll(evaluation)) throw new Error(`evaluation ${evaluation.id} has no home to hint`);
  return evaluation.createdBy === null ? [] : [teacherTopic(evaluation.createdBy)];
}

/** The one low-level exit. Everything below funnels through it. */
export function emit(event: ServerEvent, topics: Topic[], audience: Audience = "all"): void {
  publishData(event, topics, audience);
}

/** The inherited refresh hint, for everything that is not the live path. */
export function hint(type: EventType, topics: Topic[], notice?: AppNotice): void {
  publishHint(type, topics, notice);
}

/**
 * A student took their seat in a classroom (join code, or a roster line
 * claimed at login). The name is personal data: the notice goes to the
 * course's staff only — `course:` is a topic no student connection holds —
 * never on `classroom:`, where every classmate listens (#198). The joiner
 * gets a bare refresh hint on their own topic, for their list of classrooms.
 */
export function studentJoined(input: {
  courseId: string;
  classroomName: string;
  userId: string;
  name: string;
}): void {
  hint("roster", [`course:${input.courseId}`], {
    kind: "student_joined",
    name: input.name,
    classroomName: input.classroomName,
  });
  hint("roster", [userTopic(input.userId)]);
}

const cells = new Coalescer<DashboardCellEvent>(CELL_WINDOW_MS, (event) =>
  emit(event, [evaluationTopic(event.evaluationId)], "staff"),
);

const presenceEvents = new Coalescer<DashboardPresenceEvent>(PRESENCE_WINDOW_MS, (event) =>
  emit(event, [evaluationTopic(event.evaluationId)], "staff"),
);

type LobbyCount = Omit<LobbyCountEvent, "type">;

/**
 * What waits in a lobby window is not a count but the way to GET it: a
 * connect or a disconnect only marks the room dirty, and the count is taken
 * once, when the window closes. A count computed elsewhere (the ticker's
 * sweep) waits as a thunk that returns it.
 */
const lobbyCounts = new Coalescer<() => Promise<LobbyCount | null>>(PRESENCE_WINDOW_MS, (count) => {
  void count()
    .then((input) => {
      if (input) emit({ type: "lobby.count", ...input }, [evaluationTopic(input.evaluationId)], "all");
    })
    // The bus has no logger; a count that throws is a lost frame, never a
    // crash (the next window repairs it).
    .catch((err: unknown) => console.error("lobby.count: count failed", err));
});

const pollTallies = new Coalescer<PollTallyEvent>(POLL_WINDOW_MS, (event) =>
  emit(event, [evaluationTopic(event.evaluationId)], "staff"),
);

/** Emits every pending coalesced frame now. Shutdown, and tests. */
export function flushCoalescers(): void {
  cells.flush();
  presenceEvents.flush();
  lobbyCounts.flush();
  pollTallies.flush();
}

/** Drops every pending coalesced frame. Tests only. */
export function resetCoalescers(): void {
  cells.clear();
  presenceEvents.clear();
  lobbyCounts.clear();
  pollTallies.clear();
}

// --- The live catalogue ---------------------------------------------------

export function evaluationState(input: {
  evaluationId: string;
  state: EvaluationState;
  pausedAt: Date | null;
  closesAt: Date | null;
  now: Date;
}): void {
  emit(
    {
      type: "evaluation.state",
      evaluationId: input.evaluationId,
      state: input.state,
      pausedAt: isoOrNull(input.pausedAt),
      closesAt: isoOrNull(input.closesAt),
      serverNow: iso(input.now),
    },
    [evaluationTopic(input.evaluationId)],
  );
}

export function attemptDeadline(input: {
  attemptId: string;
  evaluationId: string;
  deadlineAt: Date | null;
  bonusS: number;
  reason: AttemptDeadlineEvent["reason"];
  now: Date;
}): void {
  emit(
    {
      type: "attempt.deadline",
      attemptId: input.attemptId,
      deadlineAt: isoOrNull(input.deadlineAt),
      bonusS: input.bonusS,
      reason: input.reason,
      serverNow: iso(input.now),
    },
    [attemptTopic(input.attemptId)],
  );
}

export function attemptClosed(input: {
  attemptId: string;
  evaluationId: string;
  closedBy: ClosedBy;
  now: Date;
}): void {
  const event: AttemptClosedEvent = {
    type: "attempt.closed",
    attemptId: input.attemptId,
    evaluationId: input.evaluationId,
    closedBy: input.closedBy,
    serverNow: iso(input.now),
  };
  // The student's OWN stream gets it; the dashboard watches the evaluation
  // and gets it too, but as a staff-only copy: on the evaluation topic this
  // frame would otherwise tell every student in the room which classmate
  // submitted, and when.
  emit(event, [attemptTopic(input.attemptId)]);
  emit(event, [evaluationTopic(input.evaluationId)], "staff");
}

/** Coalesced 250 ms per `(attemptId, itemId)`; staff connections only. */
export function dashboardCell(input: {
  evaluationId: string;
  attemptId: string;
  itemId: string;
  status: CellStatus;
  revision: number;
  points: number | null;
  summary: string | null;
  flagged: boolean;
  verdict: Verdict | null;
}): void {
  cells.push(`${input.attemptId}:${input.itemId}`, { type: "dashboard.cell", ...input });
}

/** Coalesced 1 s per user; staff connections only. */
export function dashboardPresence(input: {
  evaluationId: string;
  userId: string;
  online: boolean;
  lastSeenAt: Date;
}): void {
  presenceEvents.push(`${input.evaluationId}:${input.userId}`, {
    type: "dashboard.presence",
    evaluationId: input.evaluationId,
    userId: input.userId,
    online: input.online,
    lastSeenAt: iso(input.lastSeenAt),
  });
}

/**
 * A roster row acquired an attempt, or started it. Staff connections only,
 * and NOT coalesced: it fires at most twice per student and per evaluation,
 * and it is the frame that turns "never connected" into a live row.
 */
export function dashboardAttempt(input: {
  evaluationId: string;
  userId: string;
  attemptId: string;
  state: AttemptState;
  startedAt: Date | null;
  deadlineAt: Date | null;
}): void {
  const event: DashboardAttemptEvent = {
    type: "dashboard.attempt",
    evaluationId: input.evaluationId,
    userId: input.userId,
    attemptId: input.attemptId,
    state: input.state,
    startedAt: isoOrNull(input.startedAt),
    deadlineAt: isoOrNull(input.deadlineAt),
  };
  emit(event, [evaluationTopic(input.evaluationId)], "staff");
}

/** Coalesced 1 s; everyone watching the evaluation receives it (F-LIVE-02). */
export function lobbyCount(input: LobbyCount): void {
  lobbyCounts.push(input.evaluationId, () => Promise.resolve(input));
}

/**
 * The same frame, counted by `count` when the window closes — once per
 * window however many connections pushed it. `count` must not reject; it
 * answers `null` when there is nothing to announce.
 */
export function lobbyRecount(
  evaluationId: string,
  count: () => Promise<LobbyCount | null>,
): void {
  lobbyCounts.push(evaluationId, count);
}

/**
 * Grading progress (§4.8, F-GRADE-03). Addressed to the teachers of the
 * course — who hold `teacher:<id>` whether or not they have the dashboard
 * open — AND to the evaluation topic, which is what a dashboard watches.
 * Staff only: a student has no business knowing how far the correction is.
 */
export function gradingProgress(input: {
  evaluationId: string;
  done: number;
  total: number;
  phase: GradingProgressEvent["phase"];
  teacherIds: readonly string[];
}): void {
  emit(
    {
      type: "grading.progress",
      evaluationId: input.evaluationId,
      done: input.done,
      total: input.total,
      phase: input.phase,
    },
    [evaluationTopic(input.evaluationId), ...input.teacherIds.map(teacherTopic)],
    "staff",
  );
}

/**
 * The whole aggregate of a running poll (F-LIVE-13), coalesced 500 ms per
 * EVALUATION and staff only: the projection is a teacher screen, and a
 * participant must not read the distribution before the reveal.
 *
 * The frame carries the complete tally rather than a delta, so a projection
 * that missed one is right again on the next one.
 */
export function pollTally(input: {
  evaluationId: string;
  tally: PollTallyEvent["tally"];
  now: Date;
}): void {
  pollTallies.push(input.evaluationId, {
    type: "poll.tally",
    evaluationId: input.evaluationId,
    tally: input.tally,
    serverNow: iso(input.now),
  });
}

/** Addressed to the student who pressed Run, never to a topic they share. */
export function runnerResult(
  userId: string,
  requestId: string,
  itemId: string,
  result: RunnerResultEvent["result"],
): void {
  emit({ type: "runner.result", requestId, itemId, result }, [userTopic(userId)]);
}
