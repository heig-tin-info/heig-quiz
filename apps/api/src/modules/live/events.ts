/**
 * Events of the `live` module (PLAN-MVP §4.8 routing table).
 *
 * Every function here is a THIN adapter over `modules/realtime/bus.ts`: it
 * names the domain fact, the bus decides the topics, the audience and the
 * coalescing. The service never formats an event itself, so there is one
 * place to read when asking "who sees this, and how often".
 */
import type { CellStatus, ClosedBy, Verdict } from "@quiz/contracts";

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
  // `attempt.deadline` rides the ATTEMPT topic — the student's own stream.
  // The dashboard watches the evaluation, so without the line below a row
  // that just started stayed "not started" until the next full refetch.
  attemptRowChanged(evaluation.id, attempt);
}

/**
 * The roster row of one student, for the teacher's grid: the attempt exists
 * now (created in the lobby), or it has started. Staff connections only.
 */
export function attemptRowChanged(evaluationId: string, attempt: AttemptRow): void {
  // A guest of a poll (`user_id is null`) has no roster row to light up.
  if (attempt.userId === null) return;
  bus.dashboardAttempt({
    evaluationId,
    userId: attempt.userId,
    attemptId: attempt.id,
    state: attempt.state,
    startedAt: attempt.startedAt,
    deadlineAt: attempt.deadlineAt,
  });
}

/**
 * The row of a teacher's own staff test, thrown away so the quiz can be
 * walked again (ADR-018). There is no typed frame for a row that ceased to
 * exist, and inventing one for a case only a teacher can cause would put a
 * deletion in the live path of an exam; the dashboards watching the
 * evaluation re-read it instead.
 */
export function attemptRemoved(evaluationId: string, userId: string): void {
  bus.hint("evaluations", [bus.evaluationTopic(evaluationId), bus.userTopic(userId)]);
}

/**
 * The grid gained or lost a ROW rather than a cell — a staff seat that just
 * took the quiz (ADR-018, decision 3: a staff seat with no attempt is listed
 * nowhere). No typed frame carries a new row, and inventing one for a case
 * only a teacher can cause would put a roster change in the live path of a
 * running exam; the dashboards watching the evaluation re-read instead.
 */
export function rosterChanged(evaluationId: string): void {
  bus.hint("evaluations", [bus.evaluationTopic(evaluationId)]);
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

/**
 * Coalesced 250 ms per `(attemptId, itemId)`, staff connections only.
 *
 * `verdict` is the live preview of ADR-020 and travels on every frame: the
 * bus has no idea which teacher has the "Results" switch on, and one
 * `grade()` of a deterministic answer costs about what the `summary` beside
 * it already costs. `points` stays null — a provisional score is not a score.
 */
export function cellChanged(input: {
  evaluationId: string;
  attemptId: string;
  itemId: string;
  status: CellStatus;
  revision: number;
  summary: string | null;
  verdict: Verdict | null;
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
