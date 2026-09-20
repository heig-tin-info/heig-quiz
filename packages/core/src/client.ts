/**
 * The browser half of the question-type contract (PLAN-MVP §1.4).
 *
 * React appears here as TYPES ONLY: `import type` is erased by
 * `verbatimModuleSyntax`, so `@quiz/core/server` never pulls React into the API
 * bundle, and this module adds no runtime import either.
 */
import type { ComponentType, LazyExoticComponent } from "react";
import type { QuestionTypeId } from "./contract.js";

export interface EditorProps<TConfig> {
  config: TConfig;
  /** The host merges, validates lazily and autosaves the draft. */
  onChange: (next: TConfig) => void;
  /** Uploads an image and returns `asset:<uuid>` for the markdown. */
  uploadAsset: (file: File) => Promise<string>;
  disabled?: boolean;
}

export interface PlayerProps<TStudent, TAnswer> {
  student: TStudent;
  answer: TAnswer | null;
  onChange: (next: TAnswer) => void;
  /** Read-only when the attempt is submitted / paused / expired. */
  readOnly: boolean;
  /** Code type only: interactive run through `POST /attempts/:id/run`. */
  run?: (payload: unknown) => Promise<unknown>;
}

export interface ReviewProps<TStudent, TAnswer, TSolution, TDetails> {
  student: TStudent;
  answer: TAnswer | null;
  /** `null` when the feedback policy hides the key. */
  solution: TSolution | null;
  details: TDetails | null;
  points: number | null;
  maxPoints: number;
  /** "teacher" shows everything; "student" respects the already-applied filtering. */
  audience: "teacher" | "student";
}

export interface StatsProps<TStudent, TAnswer> {
  student: TStudent;
  answers: TAnswer[];
}

export interface QuestionTypeClient<
  TConfig = unknown,
  TAnswer = unknown,
  TStudent = unknown,
  TSolution = unknown,
  TDetails = unknown,
> {
  readonly id: QuestionTypeId;
  /** i18n keys, not literals: "qt.mcq.label", "qt.mcq.hint". */
  readonly labelKey: string;
  readonly hintKey: string;
  readonly Icon: ComponentType<{ className?: string }>;

  /** `React.lazy`, so `qt-code` (Monaco) never enters the initial bundle (N-PERF-05). */
  readonly Editor: LazyExoticComponent<ComponentType<EditorProps<TConfig>>>;
  readonly Player: LazyExoticComponent<ComponentType<PlayerProps<TStudent, TAnswer>>>;
  readonly Review: LazyExoticComponent<ComponentType<ReviewProps<TStudent, TAnswer, TSolution, TDetails>>>;
  readonly Stats?: LazyExoticComponent<ComponentType<StatsProps<TStudent, TAnswer>>>;

  /** Empty answer for a fresh item (e.g. `{ selected: [] }`). */
  emptyAnswer(student: TStudent): TAnswer;
  /** Drives the "empty / seen / done" progress segments (F-LIVE-09). */
  isAnswered(answer: TAnswer | null): boolean;
  /** One-line rendering for the dashboard inspection panel and the cell tooltip. */
  summarize(answer: TAnswer | null, student: TStudent): string;
}

export { QUESTION_TYPE_IDS, isQuestionTypeId } from "./contract.js";
export type { QuestionTypeId } from "./contract.js";
export { defineClientRegistry, makeLookup } from "./registry.js";
export type { AnyQuestionTypeClient, ClientRegistry } from "./registry.js";
export { UnknownQuestionType } from "./errors.js";
export * from "./rng.js";
