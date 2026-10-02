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
 * Two providers (ADR-063): the real model, through the gateway of the API,
 * and the deterministic stub of development, which `config.ts` refuses in
 * production.
 */

/**
 * What is sent to the model, and nothing else. It is ANONYMOUS by
 * construction (F-LLM-04): built by the question type from its config and
 * the answer alone, it holds no name, no address, no user, attempt or item
 * id — the grading pass adds none.
 */
export interface LlmGradeRequest {
  /** The question's statement, as the student read it. */
  statement: string;
  /**
   * What the answer and the reference are, in a few English words the
   * prompt quotes: "free text", "a PlantUML class diagram".
   */
  form: string;
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
  /**
   * The points per criterion (F-GRADE-02): the model's reading of the
   * free-text rubric, or of the reference when the rubric is empty. The
   * teacher's, like the justification.
   */
  criteria: LlmCriterion[];
  /** The model that answered, shown beside the proposal (N-DATA-05). */
  model: string;
}

export interface LlmCriterion {
  criterion: string;
  points: number;
  maxPoints: number;
  /** One sentence. */
  comment: string;
}

export interface LlmService {
  /**
   * `billedTo` is the person the call is logged against (`llm_calls`,
   * F-LLM-04); it is never sent to the model.
   */
  grade(req: LlmGradeRequest, billedTo: string | null): Promise<LlmGradeOutcome>;
}
