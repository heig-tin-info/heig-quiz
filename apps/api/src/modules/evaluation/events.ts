/**
 * Events of the `evaluation` module.
 *
 * The authoring surface is not the live path: a teacher editing items does
 * not need a data frame, so those changes travel as the inherited refresh
 * HINT (ADR-005) on the classroom topic. Its one data event,
 * `evaluation.state`, is sent by whoever moves the state
 * (`bus.evaluationStateChanged`).
 */
import * as bus from "../realtime/bus.js";

/** Something about the evaluation's configuration changed. */
export function evaluationChanged(classroomId: string, evaluationId: string): void {
  bus.hint("evaluations", [`classroom:${classroomId}`, `evaluation:${evaluationId}`]);
}
