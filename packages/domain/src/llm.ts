/**
 * The LLM gateway's pure rules (ADR-058): the purposes a call is made for,
 * the models an administrator may choose, their prices, and what a call
 * costs. No I/O: the `llm` module of the API reads and writes, this decides.
 */

/**
 * Why a call is made: the `purpose` column of `llm_calls` (ADR-058 §1;
 * `assist`, the teacher assistant, ADR-080; `describe`, the proposal of a
 * pool's description, ADR-013 amendment of 2026-10-10; `domain`, the bilingual label
 * of a public pool, ADR-095; `concepts`, the probable duplicates of the
 * vocabulary, ADR-081 fifth addendum §4; `suggest`, the concepts proposed for a
 * question being edited, ADR-081 sixth addendum §6).
 */
export const LLM_PURPOSES = ["test", "grade", "generate", "review", "poll", "assist", "describe", "domain", "concepts", "suggest", "project"] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];

export interface LlmModel {
  /** The provider's model id, sent as is. */
  id: string;
  /** The name an administrator reads. */
  label: string;
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /** Whether the model takes `output_config.effort` (Haiku 4.5 refuses it). */
  effort: boolean;
}

/**
 * The models an administrator may choose, a closed list reviewed like code
 * (ADR-058 §2), with the provider's list prices of 2026-09. A model leaves it
 * the day the provider retires it.
 */
export const LLM_MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", inputPerMTok: 2, outputPerMTok: 10, effort: true },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", inputPerMTok: 4, outputPerMTok: 20, effort: true },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", inputPerMTok: 1, outputPerMTok: 5, effort: false },
] as const satisfies readonly LlmModel[];

export type LlmModelId = (typeof LLM_MODELS)[number]["id"];
export const LLM_MODEL_IDS = LLM_MODELS.map((m) => m.id) as [LlmModelId, ...LlmModelId[]];
export const DEFAULT_LLM_MODEL: LlmModelId = "claude-sonnet-5-5";

/**
 * A model of the list by id. A reply may name a model the list does not hold
 * (a dated variant): it is priced as the DEAREST model, so that the estimate
 * errs on the side of the cap.
 */
export function llmModel(id: string): LlmModel {
  return (
    LLM_MODELS.find((m) => id === m.id || id.startsWith(`${m.id}-`)) ??
    LLM_MODELS.reduce((a, b) => (b.outputPerMTok > a.outputPerMTok ? b : a))
  );
}

/** The estimated cost of a call in USD, from its token counts. */
export function llmCostUsd(modelId: string, inputTokens: number, outputTokens: number): number {
  const m = llmModel(modelId);
  return (inputTokens * m.inputPerMTok + outputTokens * m.outputPerMTok) / 1_000_000;
}

/**
 * The most a call can cost, reserved against the cap BEFORE it is made
 * (ADR-058 §5): the prompt at the input price, counted generously (one token
 * per three characters, where text averages nearer four), and the whole
 * `maxTokens` at the output price.
 */
export function llmWorstCaseUsd(modelId: string, promptChars: number, maxTokens: number): number {
  return llmCostUsd(modelId, Math.ceil(promptChars / 3), maxTokens);
}

/**
 * The model a purpose uses when the settings name none of its own, before
 * their default: a live poll waits on its answer in front of a room, so it
 * takes the fast model (ADR-072).
 */
const PURPOSE_MODELS: Partial<Record<LlmPurpose, LlmModelId>> = { poll: "claude-haiku-4-5" };

/** The model a purpose uses: its own, else its fixed one, else the default of the settings, else the platform's. */
export function modelFor(models: Partial<Record<LlmPurpose | "default", string>>, purpose: LlmPurpose): string {
  return models[purpose] ?? PURPOSE_MODELS[purpose] ?? models.default ?? DEFAULT_LLM_MODEL;
}

/** Whether the connection test's answer names Paris, whatever its case, accents or punctuation. */
export function isParis(answer: string): boolean {
  return /\bparis\b/.test(answer.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase());
}

/**
 * The purposes a person's daily share leaves out (audit L2): a grading
 * pass is billed to the evaluation's author, whoever pressed the button, and
 * is bounded by the answers the students wrote — refusing it halfway would
 * leave a class half graded. Its re-grades have their own budget
 * ({@link LLM_REGRADES_PER_ITEM_PER_DAY}). A project's pass (`project`,
 * ADR-106 §4) likewise: billed to the project's creator, one call per
 * repository, its regrades capped per project and per repository
 * ({@link PROJECT_REGRADES_PER_DAY}).
 */
export const USER_SHARE_EXEMPT: readonly LlmPurpose[] = ["grade", "project"];

/** The part of the day's cap one person may spend (audit L2), like the assistant's and the night's shares. */
export const LLM_USER_DAY_SHARE = 0.2;

/**
 * Whether a call made for a person may be reserved (audit L2): a purpose
 * the share leaves out always may; otherwise their own spend today, the
 * exempt purposes aside, stays within {@link LLM_USER_DAY_SHARE} of the
 * cap, so that no one teacher exhausts the institution's day. The cap's own
 * check still runs after.
 */
export function userShareAllows(day: {
  purpose: LlmPurpose;
  spentUserUsd: number;
  worstCaseUsd: number;
  capUsd: number;
}): boolean {
  return (
    USER_SHARE_EXEMPT.includes(day.purpose) ||
    day.spentUserUsd + day.worstCaseUsd <= LLM_USER_DAY_SHARE * day.capUsd
  );
}

/**
 * How many times a day one evaluation item may be re-graded once the model
 * grades it (audit L2): each re-grade sends every answer of the item to the
 * model again. A re-grade of an item the model never graded costs nothing
 * and is not counted.
 */
export const LLM_REGRADES_PER_ITEM_PER_DAY = 3;

/**
 * How many regrades a project graded by criteria takes a day (ADR-106 §4 as
 * amended 2026-10-12, ADR-058 L2 (b)), each capped apart: the project's own
 * (every frozen repository back to the model), and each repository's.
 */
export const PROJECT_REGRADES_PER_DAY = 3;

/**
 * Whether a teacher-assistant call may be reserved (ADR-080 §4): the chat's
 * own spend today stays within its `share` of the cap, and the day's total
 * leaves that same part of the cap to every other purpose, so the chat is
 * refused first when the cap nears. The cap's own check still runs after.
 */
export function shareAllows(
  day: { spentTotalUsd: number; spentPurposeUsd: number; worstCaseUsd: number; capUsd: number },
  share: number,
): boolean {
  const part = share * day.capUsd;
  return day.spentPurposeUsd + day.worstCaseUsd <= part && day.spentTotalUsd + day.worstCaseUsd <= day.capUsd - part;
}
