/**
 * Events of the `poll` module (docs/spec/05 §5.4, routing table).
 *
 * Thin adapters over `modules/realtime/bus.ts`, exactly like
 * `modules/live/events.ts`: this file names the domain fact, the bus decides
 * the topics, the audience and the coalescing (§10, "never publish an event
 * directly").
 */
import type { PollTally } from "@quiz/contracts";

import * as bus from "../realtime/bus.js";
import type { EvaluationRecord } from "../evaluation/service.js";

/**
 * The aggregate moved. Staff only and coalesced 500 ms by the bus: the
 * projection is a teacher screen, and a participant must not read the
 * distribution of the room before the teacher shows it.
 */
export function tallyChanged(evaluationId: string, tally: PollTally, now: Date): void {
  bus.pollTally({ evaluationId, tally, now });
}

/** A poll opened: the classroom's evaluation list has one more row. */
export function pollStarted(evaluation: EvaluationRecord, now: Date): void {
  bus.evaluationState({
    evaluationId: evaluation.id,
    state: evaluation.state,
    pausedAt: evaluation.pausedAt,
    closesAt: evaluation.closesAt,
    now,
  });
  bus.hint("evaluations", [`classroom:${evaluation.classroomId}`]);
}

/**
 * The reveal switch moved. No data frame: the projection and the phones
 * re-read the view they are allowed to see, which is what keeps the key out
 * of a frame addressed to the room (ADR-005, invariant 4).
 */
export function pollChanged(evaluation: EvaluationRecord): void {
  bus.hint("evaluations", [
    `evaluation:${evaluation.id}`,
    `classroom:${evaluation.classroomId}`,
  ]);
}
