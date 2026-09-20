/**
 * Events of the `live` module (PLAN-MVP §4.8 routing table).
 *
 * Every function here is a THIN adapter over `modules/realtime/bus.ts`: it
 * names the domain fact, the bus decides the topics, the audience and the
 * coalescing. The service never formats an event itself, so there is one
 * place to read when asking "who sees this, and how often".
 */
import type { CellStatus, ClosedBy } from "@quiz/contracts";

import * as bus from "../realtime/bus.js";
import type { EvaluationRecord } from "../evaluation/service.js";
import type { attempts } from "../../db/schema.js";

type AttemptRow = typeof attempts.$inferSelect;

export function stateChanged(evaluation: EvaluationRecord, now: Date): void {
  bus.evaluationState({
    evaluationId: evaluation.id,
    state: evaluation.state,
    pausedAt: evaluation.pausedAt,
    closesAt: evaluation.closesAt,
    now,
  });
  bus.hint("evaluations", [`classroom:${evaluation.classroomId}`]);
}

export function attemptStarted(
  evaluation: EvaluationRecord,
  attempt: AttemptRow,
  now: Date,
): void {
  bus.attemptDeadline({
    attemptId: attempt.id,
    evaluationId: evaluation.id,
    deadlineAt: attempt.deadlineAt,
    bonusS: attempt.bonusS,
    reason: "start",
    now,
  });
}

export function deadlineChanged(
  evaluation: EvaluationRecord,
  attempt: AttemptRow,
  reason: "teacher_extend" | "pause_resume" | "reopen",
  now: Date,
): void {
  bus.attemptDeadline({
    attemptId: attempt.id,
    evaluationId: evaluation.id,
    deadlineAt: attempt.deadlineAt,
    bonusS: attempt.bonusS,
    reason,
    now,
  });
}

export function attemptClosed(
  evaluationId: string,
  attempt: Pick<AttemptRow, "id">,
  closedBy: ClosedBy,
  now: Date,
): void {
  bus.attemptClosed({ attemptId: attempt.id, evaluationId, closedBy, now });
}

/** Coalesced 250 ms per `(attemptId, itemId)`, staff connections only. */
export function cellChanged(input: {
  evaluationId: string;
  attemptId: string;
  itemId: string;
  status: CellStatus;
  revision: number;
  summary: string | null;
}): void {
  bus.dashboardCell({ ...input, points: null });
}

export function presenceChanged(
  evaluationId: string,
  userId: string,
  online: boolean,
  lastSeenAt: Date,
): void {
  bus.dashboardPresence({ evaluationId, userId, online, lastSeenAt });
}

export function lobbyChanged(evaluationId: string, present: number, enrolled: number): void {
  bus.lobbyCount({ evaluationId, present, enrolled });
}

export function runnerResult(
  userId: string,
  requestId: string,
  itemId: string,
  result: Parameters<typeof bus.runnerResult>[3],
): void {
  bus.runnerResult(userId, requestId, itemId, result);
}
