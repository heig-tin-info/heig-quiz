/**
 * LLM grading (F-GRADE-02, ADR-045, ADR-063): what a question type asks of a
 * model, and what comes back.
 *
 * A question type that wants a model's opinion returns `pending: "llm"` with
 * an {@link LlmGradeRequest}; the grading pass hands it to the ONE grading
 * service of the API (`app.llm`: the real model through the gateway, or the
 * development stub) and writes the reply as a PROPOSAL, kept for the teacher
 * alone. A type never calls a model: it reads `GradeContext.llm`, which says
 * whether one will be asked, and a type that can grade otherwise (the essay,
 * by hand) does not ask when none will.
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

