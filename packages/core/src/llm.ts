/**
 * The LLM grading service (F-GRADE-02, ADR-045).
 *
 * A question type that wants a model's opinion returns `pending: "llm"` with
 * an {@link LlmGradeRequest}; the grading pass hands it to the ONE service of
 * the process (`app.llm`) and writes the reply as a PROPOSAL carrying the
 * model's confidence, its justification kept for the teacher alone. Without
 * a service the pass writes a 0-point proposal with reason
 * `llm_not_configured`, and a type that can grade otherwise (the essay, by
 * hand) does not ask at all: it reads `GradeContext.llm` first.
 *
 * The only provider today is the deterministic stub of development, which
 * `config.ts` refuses in production.
 */

/**
 * What is sent to the model, and nothing else. It is ANONYMOUS by
 * construction (F-LLM-04): built by the question type from its config and
 * the answer alone, it holds no name, no address, no user, attempt or item
 * id — the grading pass adds none.
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
  /** On the item's scale; the pass clamps it to `[0, maxPoints]`. */
  points: number;
  /**
   * Why: for the TEACHER only (ADR-045, open question 27). The pass stores
   * it in the grading's details under `JUSTIFICATION_KEY`
   * (`@quiz/core/reasons`), never as the comment a student may read.
   */
  justification: string;
  /** How sure the model says it is: what the batch and its filter read (F-GRADE-04). */
  confidence: "low" | "medium" | "high";
}

export interface LlmService {
  grade(req: LlmGradeRequest): Promise<LlmGradeOutcome>;
}
