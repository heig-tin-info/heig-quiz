/**
 * The question-type contract (PLAN-MVP §1.2 and §1.3).
 *
 * Adding a question type means implementing {@link QuestionTypeServer} here and
 * {@link QuestionTypeClient} in `./client`, then registering both in
 * `packages/registry`. `packages/core` must never import a `qt-*` package
 * (decision D1).
 */
import type { z } from "zod";
import type { LlmGradeRequest, LlmService } from "./llm.js";
import type { RunnerOutcome, RunnerRequest, RunnerService } from "./runner.js";

/** The four types of the MVP (PLAN-MVP §0). */
export const QUESTION_TYPE_IDS = ["mcq", "short", "cloze", "code"] as const;
export type QuestionTypeId = (typeof QUESTION_TYPE_IDS)[number];

export function isQuestionTypeId(id: string): id is QuestionTypeId {
  return (QUESTION_TYPE_IDS as readonly string[]).includes(id);
}

// ---------------------------------------------------------------------------
// GradeResult
// ---------------------------------------------------------------------------

/** Points are on the item scale already (0 … maxPoints), rounded to 2 decimals. */
export interface GradedResult<D = unknown> {
  kind: "graded";
  points: number;
  maxPoints: number;
  /** Type-specific breakdown, stored verbatim in `gradings.details`. */
  details: D;
  /** Grading born validated (deterministic) or proposed (needs teacher eyes). */
  state?: "validated" | "proposed";
  /** Optional machine comment shown to the teacher, e.g. "runner unavailable". */
  comment?: string;
}

export interface PendingRunnerResult {
  kind: "pending";
  via: "runner";
  /** Fully assembled, server-side. Never contains student-supplied file names. */
  request: RunnerRequest;
  /** Partial details already known (e.g. assembled source hash). */
  details?: unknown;
}

export interface PendingLlmResult {
  kind: "pending";
  via: "llm";
  /** Phase 2. The MVP grading worker rejects this with `llm_unavailable`. */
  request: LlmGradeRequest;
}

export type GradeResult<D = unknown> = GradedResult<D> | PendingRunnerResult | PendingLlmResult;

export const isGraded = <D>(r: GradeResult<D>): r is GradedResult<D> => r.kind === "graded";

export const isPendingRunner = <D>(r: GradeResult<D>): r is PendingRunnerResult =>
  r.kind === "pending" && r.via === "runner";

export const isPendingLlm = <D>(r: GradeResult<D>): r is PendingLlmResult =>
  r.kind === "pending" && r.via === "llm";

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

/** What the student is allowed to see right now. */
export interface StudentView {
  /** Attempt seed; 0 for the teacher preview (stable preview). */
  seed: number;
  itemId: string;
  /** Evaluation-level shuffle switch AND question-level shuffleable flag, ANDed by the caller. */
  shuffle: boolean;
}

export interface GradeContext {
  seed: number;
  itemId: string;
  attemptId: string;
  /** `evaluation_items.points` — the scale the grader must produce points on. */
  itemPoints: number;
  now: Date;
  /** Always present; may be the unavailable stub (throws `RunnerUnavailable`). */
  runner: RunnerService;
  /** Phase 2; undefined in MVP. */
  llm?: LlmService;
}

/** The context of the second half of a runner grading: no service is reachable from there. */
export type FinalizeContext = Omit<GradeContext, "runner" | "llm">;

/**
 * What the feedback policy allows inside a grading `details` payload.
 *
 * It is the subset of `FeedbackPolicy` (`@quiz/contracts`) a question type
 * needs to redact its own breakdown; `packages/core` does not import the
 * contracts, and a type never sees the rest of the policy.
 */
export interface StudentDetailsPolicy {
  /** The teacher publishes the answer key: the details may travel whole. */
  showKey: boolean;
  /** docs/06 Q8: the names of a `code` question's hidden cases. */
  showHiddenCaseNames: boolean;
}

// ---------------------------------------------------------------------------
// QuestionTypeServer
// ---------------------------------------------------------------------------

export interface QuestionTypeServer<
  TConfig = unknown,
  TAnswer = unknown,
  TStudent = unknown,
  TSolution = unknown,
  TDetails = unknown,
> {
  readonly id: QuestionTypeId;
  /** Bumped when `configSchema` changes shape; stored in `question_versions.config_version`. */
  readonly configVersion: number;

  readonly configSchema: z.ZodType<TConfig>;
  readonly answerSchema: z.ZodType<TAnswer>;
  readonly studentSchema: z.ZodType<TStudent>;
  readonly solutionSchema: z.ZodType<TSolution>;
  readonly detailsSchema: z.ZodType<TDetails>;

  /** Config of a freshly created draft, valid against `configSchema`. */
  emptyDraft(): TConfig;

  /** Raise an old stored config to `configVersion`. Pure, total, never throws on a config it emitted before. */
  migrate(config: unknown, fromVersion: number): TConfig;

  /** F-EVAL-02 default item points. */
  defaultPoints(config: TConfig): number;

  /** Whether shuffling is meaningful for this config (mcq with `shuffleChoices`, cloze with selects). */
  shuffleable(config: TConfig): boolean;

  /**
   * THE single content exit toward a student (docs/05 §5.7).
   * Must never return the answer key, explanation, hidden test bodies, matchers,
   * regexes, tolerances, internal name, tags or difficulty. Pure and tested by
   * key-blacklist + key-value search on the serialized output.
   */
  toStudent(config: TConfig, view: StudentView): TStudent;

  /** Key + rationale for review, served ONLY when the feedback policy allows it. */
  toSolution(config: TConfig, view: StudentView): TSolution;

  /**
   * The grading breakdown as a STUDENT may read it (docs/05 §5.7).
   *
   * `details` is written by `grade` for the teacher, so it holds whatever the
   * type needs to justify a score — the correct choices, the expected blanks,
   * a hidden test's output. This hook is where the answer key comes back out
   * of it when `policy.showKey` is false. Omitting it means "the breakdown
   * holds no key"; the `results` module strips the forbidden keys either way.
   */
  studentDetails?(details: TDetails, policy: StudentDetailsPolicy): unknown;

  /** Phase 2 random values; absent in MVP packages. */
  randomize?(config: TConfig, seed: number): TConfig;

  /** `answer === null` means "not answered": graders must return 0 points (F-GRADE-01). */
  grade(
    config: TConfig,
    answer: TAnswer | null,
    ctx: GradeContext,
  ): GradeResult<TDetails> | Promise<GradeResult<TDetails>>;

  /** Second half of a `pending: runner` grading. Pure, so it is unit-testable without a runner. */
  finalizeRunner?(
    config: TConfig,
    answer: TAnswer | null,
    ctx: FinalizeContext,
    outcome: RunnerOutcome,
  ): GradedResult<TDetails>;

  /** Text fed to the tsvector of `question_versions.search`. */
  searchText(config: TConfig): string;

  /** Canonical YAML mapping; identity when omitted. */
  toCanonical?(config: TConfig): unknown;
  fromCanonical?(raw: unknown): TConfig;
}
