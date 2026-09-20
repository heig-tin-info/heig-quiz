/**
 * Events of the `evaluation` module.
 *
 * The authoring surface is not the live path: a teacher editing items does
 * not need a data frame, so those changes travel as the inherited refresh
 * HINT (ADR-005) on the classroom topic. The one data event that belongs to
 * this module is `evaluation.state`, which the student lobby and the teacher
 * dashboard both act on within a second (F-LIVE-04).
 */
import type { EvaluationState } from "@quiz/contracts";

import * as bus from "../realtime/bus.js";

/** Something about the evaluation's configuration changed. */
export function evaluationChanged(classroomId: string, evaluationId: string): void {
  bus.hint("evaluations", [`classroom:${classroomId}`, `evaluation:${evaluationId}`]);
}

/** The state column moved: everyone watching the evaluation must know now. */
export function stateChanged(input: {
  classroomId: string;
  evaluationId: string;
  state: EvaluationState;
  pausedAt: Date | null;
  closesAt: Date | null;
  now: Date;
}): void {
  bus.evaluationState(input);
  // The classroom listing shows the state badge; it is not worth a data frame.
  bus.hint("evaluations", [`classroom:${input.classroomId}`]);
}
