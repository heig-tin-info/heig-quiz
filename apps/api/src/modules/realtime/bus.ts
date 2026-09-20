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
  CellStatus,
  ClosedBy,
  DashboardCellEvent,
  DashboardPresenceEvent,
  EvaluationState,
  LobbyCountEvent,
  RunnerResultEvent,
  ServerEvent,
  Topic,
} from "@quiz/contracts";

import { iso, isoOrNull } from "../../clock.js";
import {
  publish as publishHint,
  publishData,
  type Audience,
  type AppNotice,
  type EventType,
} from "../../events.js";
import { Coalescer } from "./coalesce.js";

/** PLAN-MVP §4.8 routing table. */
export const CELL_WINDOW_MS = 250;
export const PRESENCE_WINDOW_MS = 1000;

export const evaluationTopic = (id: string): Topic => `evaluation:${id}`;
export const attemptTopic = (id: string): Topic => `attempt:${id}`;
export const userTopic = (id: string): Topic => `user:${id}`;

/** The one low-level exit. Everything below funnels through it. */
export function emit(event: ServerEvent, topics: Topic[], audience: Audience = "all"): void {
  publishData(event, topics, audience);
}

/** The inherited refresh hint, for everything that is not the live path. */
export function hint(type: EventType, topics: Topic[], notice?: AppNotice): void {
  publishHint(type, topics, notice);
}

const cells = new Coalescer<DashboardCellEvent>(CELL_WINDOW_MS, (event) =>
  emit(event, [evaluationTopic(event.evaluationId)], "staff"),
);

const presenceEvents = new Coalescer<DashboardPresenceEvent>(PRESENCE_WINDOW_MS, (event) =>
  emit(event, [evaluationTopic(event.evaluationId)], "staff"),
);

const lobbyCounts = new Coalescer<LobbyCountEvent>(PRESENCE_WINDOW_MS, (event) =>
  emit(event, [evaluationTopic(event.evaluationId)], "all"),
);

/** Emits every pending coalesced frame now. Shutdown, and tests. */
export function flushCoalescers(): void {
  cells.flush();
  presenceEvents.flush();
  lobbyCounts.flush();
}

/** Drops every pending coalesced frame. Tests only. */
export function resetCoalescers(): void {
  cells.clear();
  presenceEvents.clear();
  lobbyCounts.clear();
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
  // Both the student (their own stream) and the dashboard need it, and the
  // dashboard watches the evaluation, not each attempt.
  emit(event, [attemptTopic(input.attemptId), evaluationTopic(input.evaluationId)]);
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

/** Coalesced 1 s; everyone watching the evaluation receives it (F-LIVE-02). */
export function lobbyCount(input: {
  evaluationId: string;
  present: number;
  enrolled: number;
}): void {
  lobbyCounts.push(input.evaluationId, { type: "lobby.count", ...input });
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
