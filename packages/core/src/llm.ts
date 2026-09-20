/**
 * Phase 2 placeholder (PLAN-MVP §0: all of F-LLM is out of the MVP).
 *
 * The shapes exist only so `GradeResult` can carry a `pending: "llm"` branch
 * and `GradeContext` can declare an optional service. The MVP grading worker
 * rejects a `pending: "llm"` result with `llm_unavailable`, and a config
 * holding an `llm` matcher is refused at publication.
 */

export interface LlmGradeRequest {
  /** The teacher's rubric, verbatim. */
  rubric: string;
  /** An optional reference answer. */
  reference?: string;
  /** The student's answer, already normalised by the question type. */
  answer: string;
  /** The item scale the model must produce points on. */
  maxPoints: number;
}

export interface LlmGradeOutcome {
  points: number;
  comment: string;
}

export interface LlmService {
  grade(req: LlmGradeRequest): Promise<LlmGradeOutcome>;
}
