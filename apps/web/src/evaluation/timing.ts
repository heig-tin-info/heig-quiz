/*
 * The timing the configuration screen needs before the launch step (#76).
 *
 * The rule itself is `missingTimingFields` in `@quiz/domain`, the one the API
 * applies when it refuses to open the waiting room; this module only reads it
 * off an `Evaluation` and says where each missing field sits on the screen, so
 * "Go to launch" can put the focus on it and the launch step can name it.
 */
import { TransitionRefusal, type Evaluation } from "@quiz/contracts";
import { missingTimingFields, type EvaluationTiming, type TimingField } from "@quiz/domain";

import { ApiError } from "../api";
import type { Dict, TFunction } from "../i18n";

export type { TimingField };

export function missingTiming(evaluation: Evaluation): TimingField[] {
  return missingTimingFields({
    mode: evaluation.mode,
    timing: evaluation.settings.timing,
    durationS: evaluation.durationS,
    opensAt: evaluation.opensAt,
    closesAt: evaluation.closesAt,
  });
}

/** The DOM id of the control that fixes each field, for the focus and `aria-describedby`. */
export const TIMING_FIELD_ID: Record<TimingField, string> = {
  durationS: "eval-duration",
  opensAt: "eval-opens-at",
  closesAt: "eval-closes-at",
};

/**
 * What to do about each missing field, in the teacher's words: the end a
 * live exam needs is its safety deadline (ADR-086 §2), not a window's end.
 */
export function missingTimingKey(field: TimingField, timing: EvaluationTiming): keyof Dict {
  return field === "closesAt" && timing === "manual" ? "eval.missing.closesAt.live" : `eval.missing.${field}`;
}

/** A `datetime-local` value from an ISO instant, in the reader's own zone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/** The ISO instant of a `datetime-local` value, or null when it is empty or invalid. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * What a refused state change says, in the teacher's language (#76). The
 * server's `message` is English for logs and API clients; the screen reads
 * the machine half of the refusal instead: a missing question, the timing
 * fields still to fill, a schedule without its opening time (#152), a time
 * already past by the server's clock (#178), or a move the evaluation no longer allows because it changed elsewhere.
 * Anything else is the ordinary "server did not answer". `timing` words the
 * missing fields in the evaluation's mode (`missingTimingKey`).
 */
export function transitionErrorMessage(error: unknown, t: TFunction, timing: EvaluationTiming): string {
  if (!(error instanceof ApiError)) return t("error.server");
  const refusal = TransitionRefusal.safeParse(error.body);
  if (!refusal.success) return t("error.server");
  const { reason, missing } = refusal.data;
  if (reason === "no_items") return t("eval.launch.needQuestions");
  if (reason === "no_graded_points") return t("eval.launch.needGradedPoints");
  if (reason === "opens_at_missing") return t("eval.launch.opensAtMissing");
  if (reason === "opens_at_past") return t("launch.schedule.past");
  if (reason === "closes_at_past") return t("eval.launch.closesAtPast");
  if (reason === "timing_incomplete" && missing && missing.length > 0) {
    return missing.map((field) => t(missingTimingKey(field, timing))).join(" ");
  }
  return t("eval.launch.stale");
}
