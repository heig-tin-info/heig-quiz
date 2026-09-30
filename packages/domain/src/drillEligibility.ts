/**
 * Which questions the drill may serve (ADR-041 §3): a type of the product's
 * v1 scope, whose grading of the answer is automatic and final — graded at
 * once, not pending a runner or an LLM, not a proposal waiting for a
 * teacher. A review has nobody to wait for.
 */
import type { GradeResult, QuestionTypeId } from "@quiz/core/server";

/** The product scope of v1 (ADR-041 §3). */
export const DRILL_TYPES = ["mcq", "short", "cloze", "categorize"] as const satisfies readonly QuestionTypeId[];

/** True when a question of `type`, graded as `result`, can be a drill card. */
export function isDrillEligible(type: string, result: GradeResult): boolean {
  return (
    (DRILL_TYPES as readonly string[]).includes(type) && result.kind === "graded" && result.state !== "proposed"
  );
}
