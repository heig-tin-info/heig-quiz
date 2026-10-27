/**
 * `@quiz/core/reasons` — the machine reasons of a grading (ADR-044): why a
 * machine PROPOSED instead of grading, the `details.reason` (and the
 * `comment`) of a grading no grader could settle. Wire values, closed here
 * once for the API (through `@quiz/contracts`, which re-exports them), the
 * web, and the grading columns of the question types (`@quiz/ui`), which
 * cannot depend on `@quiz/contracts`. No runtime import: plain values.
 */
import type { LlmCriterion } from "./llm.js";

/**
 * Why a machine PROPOSED instead of grading: the `details.reason` (and the
 * `comment`) of a grading no grader could settle. Wire values, closed here
 * once: the grading pass writes the first ten (`jobs.ts`; `runner_busy` on
 * the last try of a saturated runner, ADR-101), question types the next
 * four (a circuit's or a program's own fault, issue #267). The web
 * translates every one of them.
 */
export const PASS_REASONS = [
  "config_unreadable",
  "answer_invalid",
  "grader_error",
  "llm_not_configured",
  "llm_budget",
  "not_finalizable",
  "runner_unavailable",
  "runner_error",
  "finalize_error",
  "runner_busy",
] as const;
export type PassReason = (typeof PASS_REASONS)[number];

export const MACHINE_REASONS = [
  ...PASS_REASONS,
  "reference_failed",
  "palette_violation",
  "runner_request_invalid",
  "template_region_mismatch",
] as const;
export type MachineReason = (typeof MACHINE_REASONS)[number];

export const isMachineReason = (value: unknown): value is MachineReason =>
  typeof value === "string" && (MACHINE_REASONS as readonly string[]).includes(value);

/**
 * The reasons that wait for the runner: absent (D14) or saturated on the
 * last try (ADR-101). The progress counts them as pending on the runner.
 */
export const RUNNER_WAITING_REASONS = ["runner_unavailable", "runner_busy"] as const satisfies readonly MachineReason[];

/**
 * The reasons a new pass may clear: the runner or a grader was away or
 * failed. The others are the question's own fault (a reference that fails,
 * an unreadable configuration, no model configured) and only an edit of the
 * question or of the platform settles them, so the panel does not offer a
 * pass for them.
 */
export const RETRYABLE_REASONS = [
  "runner_unavailable",
  "runner_error",
  "runner_busy",
  "grader_error",
  "llm_budget",
  "finalize_error",
  "not_finalizable",
] as const satisfies readonly MachineReason[];

export const isRetryableReason = (value: unknown): boolean =>
  typeof value === "string" && (RETRYABLE_REASONS as readonly string[]).includes(value);

/** `details.reason`, the one field every machine-written grading carries. */
export function reasonOf(details: unknown): string | null {
  if (details && typeof details === "object" && "reason" in details) {
    const reason = (details as { reason: unknown }).reason;
    return typeof reason === "string" ? reason : null;
  }
  return null;
}

/**
 * Where a grading's `details` keep an LLM's justification (ADR-045): written
 * by the grading pass beside the type's own fields, read by the teacher's
 * grading panel, and stripped from every student payload whatever the
 * feedback policy (`filterDetails`), pending open question 27.
 */
export const JUSTIFICATION_KEY = "justification";

/**
 * Where a grading's `details` say that the instance of a parameterized
 * question was served from a fallback draw (ADR-056 §7): `"exhausted"` when
 * the condition never held in 100 runs, `"failed"` when the drawn values did
 * not render. The teacher's, like {@link JUSTIFICATION_KEY}: stripped from
 * every student payload whatever the policy — the student never sees an error.
 */
export const INSTANCE_WARNING_KEY = "instanceWarning";

/**
 * Where a grading's `details` keep the rest of an LLM's reply (ADR-063): the
 * model that answered and its points per criterion. The teacher's, like
 * {@link JUSTIFICATION_KEY}: stripped from every student payload.
 */
export const AI_KEY = "ai";

export interface AiDetails {
  model: string;
  criteria: LlmCriterion[];
}

/** `details.ai`, when an LLM wrote it. */
export function aiOf(details: unknown): AiDetails | null {
  if (details && typeof details === "object" && AI_KEY in details) {
    const ai = (details as Record<string, unknown>)[AI_KEY];
    if (ai && typeof ai === "object" && Array.isArray((ai as AiDetails).criteria)) return ai as AiDetails;
  }
  return null;
}

/** `details.justification`, when an LLM wrote one. */
export function justificationOf(details: unknown): string | null {
  if (details && typeof details === "object" && JUSTIFICATION_KEY in details) {
    const text = (details as Record<string, unknown>)[JUSTIFICATION_KEY];
    return typeof text === "string" ? text : null;
  }
  return null;
}

/**
 * What a criterion's id may hold (ADR-118): letters, digits, `_` and `-`,
 * a plain JSON property name, since the model's reply is keyed by it. One
 * pattern for the question's config and the grading routes that name it.
 */
export const CRITERION_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Where a grading's `details` keep the VALIDATED points of an essay's
 * criteria (ADR-118 §6, amendment of 2026-10-27): written when a teacher
 * validates or overrides a grading of an item whose criteria every entry
 * names, in the criteria's order, the titles snapshotted from the item's
 * version, the points on the item's scale. Distinct from {@link AI_KEY}:
 * never a weight, a prompt, a sentence or a model. A student reads it only
 * under a shown key (the type's `studentDetails`).
 */
export const BREAKDOWN_KEY = "breakdown";

export interface BreakdownEntry {
  id: string;
  title: string;
  points: number;
  maxPoints: number;
}

const isBreakdownEntry = (e: unknown): e is BreakdownEntry =>
  e !== null &&
  typeof e === "object" &&
  typeof (e as BreakdownEntry).id === "string" &&
  typeof (e as BreakdownEntry).title === "string" &&
  typeof (e as BreakdownEntry).points === "number" &&
  typeof (e as BreakdownEntry).maxPoints === "number";

/** `details.breakdown`, when a validation wrote one. */
export function breakdownOf(details: unknown): BreakdownEntry[] | null {
  if (details && typeof details === "object" && BREAKDOWN_KEY in details) {
    const list = (details as Record<string, unknown>)[BREAKDOWN_KEY];
    if (Array.isArray(list) && list.every(isBreakdownEntry)) return list;
  }
  return null;
}
