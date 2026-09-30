import type {
  GradingConfidence,
  GradingEntry,
  GradingSource,
  GradingState,
  MachineReason,
} from "@quiz/contracts";
import { isMachineReason } from "@quiz/contracts";

import type { Dict, TFunction } from "../i18n";
import type { Tone } from "../ui";

/**
 * The words and tones the grading screen puts on an answer. Kept out of the
 * components so the same word reads the same in the table, in the answer
 * panel and in the history.
 */

const SOURCE_KEYS: Record<GradingSource, keyof Dict> = {
  auto: "grading.source.auto",
  llm: "grading.source.llm",
  manual: "grading.source.manual",
};

const STATE_KEYS: Record<GradingState, keyof Dict> = {
  proposed: "grading.state.proposed",
  validated: "grading.state.validated",
  superseded: "grading.state.superseded",
};

/** The confidence in one word ("High"), where the row already says "AI". */
const CONFIDENCE_KEYS: Record<GradingConfidence, keyof Dict> = {
  low: "grading.filter.confidence.low",
  medium: "grading.filter.confidence.medium",
  high: "grading.filter.confidence.high",
};

export const sourceLabel = (t: TFunction, s: GradingSource) => t(SOURCE_KEYS[s]);
export const gradingStateLabel = (t: TFunction, s: GradingState) => t(STATE_KEYS[s]);
export const confidenceLabelShort = (t: TFunction, c: GradingConfidence) =>
  t(CONFIDENCE_KEYS[c]);

export const stateTone = (s: GradingState): Tone =>
  s === "validated" ? "green" : s === "proposed" ? "amber" : "zinc";

/**
 * Why a machine PROPOSED instead of grading, in the author's words: every
 * code of `MACHINE_REASONS` (`@quiz/contracts`) has its sentence — a full
 * record, so a code added there without one is a compile error here — and
 * one the web does not know reads as a generic sentence, never as the raw
 * code (issue #267).
 */
const REASON_KEYS: Record<MachineReason, keyof Dict> = {
  config_unreadable: "grading.reason.config_unreadable",
  answer_invalid: "grading.reason.answer_invalid",
  grader_error: "grading.reason.grader_error",
  llm_not_configured: "grading.reason.llm_not_configured",
  not_finalizable: "grading.reason.not_finalizable",
  runner_unavailable: "grading.reason.runner_unavailable",
  runner_error: "grading.reason.runner_error",
  finalize_error: "grading.reason.finalize_error",
  reference_failed: "grading.reason.reference_failed",
  palette_violation: "grading.reason.palette_violation",
  runner_request_invalid: "grading.reason.runner_request_invalid",
  template_region_mismatch: "grading.reason.template_region_mismatch",
  runner_busy: "grading.reason.runner_busy",
};

export const machineReason = (t: TFunction, comment: string): string =>
  t(isMachineReason(comment) ? REASON_KEYS[comment] : "grading.reason.unknown");

/**
 * Who gave an answer, when names are shown: the name the server sent, or a
 * guest's number worded in the reader's language (ADR-014). Anonymised, the
 * server sends neither, and this says so.
 */
export function whoOf(t: TFunction, entry: Pick<GradingEntry, "label" | "guest">): string {
  if (entry.label !== null) return entry.label;
  return entry.guest !== null
    ? t("grading.guest", { n: entry.guest })
    : t("grading.panel.anonymous");
}
