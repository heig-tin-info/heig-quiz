/**
 * `@quiz/core/reasons` — the machine reasons of a grading (ADR-044): why a
 * machine PROPOSED instead of grading, the `details.reason` (and the
 * `comment`) of a grading no grader could settle. Wire values, closed here
 * once for the API (through `@quiz/contracts`, which re-exports them), the
 * web, and the grading columns of the question types (`@quiz/ui`), which
 * cannot depend on `@quiz/contracts`. No runtime import: plain values.
 */

/**
 * Why a machine PROPOSED instead of grading: the `details.reason` (and the
 * `comment`) of a grading no grader could settle. Wire values, closed here
 * once: the grading pass writes the first eight (`jobs.ts`), question types
 * the next four (a circuit's or a program's own fault, issue #267), and the
 * runner's saturation the last. The web translates every one of them.
 */
export const PASS_REASONS = [
  "config_unreadable",
  "answer_invalid",
  "grader_error",
  "llm_not_configured",
  "not_finalizable",
  "runner_unavailable",
  "runner_error",
  "finalize_error",
] as const;
export type PassReason = (typeof PASS_REASONS)[number];

export const MACHINE_REASONS = [
  ...PASS_REASONS,
  "reference_failed",
  "palette_violation",
  "runner_request_invalid",
  "template_region_mismatch",
  "runner_busy",
] as const;
export type MachineReason = (typeof MACHINE_REASONS)[number];

export const isMachineReason = (value: unknown): value is MachineReason =>
  typeof value === "string" && (MACHINE_REASONS as readonly string[]).includes(value);

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

/** `details.justification`, when an LLM wrote one. */
export function justificationOf(details: unknown): string | null {
  if (details && typeof details === "object" && JUSTIFICATION_KEY in details) {
    const text = (details as Record<string, unknown>)[JUSTIFICATION_KEY];
    return typeof text === "string" ? text : null;
  }
  return null;
}
