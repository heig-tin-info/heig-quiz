/*
 * The timing the configuration screen needs before the launch step (#76).
 *
 * The rule itself is `missingTimingFields` in `@quiz/domain`, the one the API
 * applies when it refuses to open the waiting room; this module only reads it
 * off an `Evaluation` and says where each missing field sits on the screen, so
 * "Go to launch" can put the focus on it and the launch step can name it.
 */
import type { Evaluation } from "@quiz/contracts";
import { missingTimingFields, type TimingField } from "@quiz/domain";

import type { Dict } from "../i18n";

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
  timing: "eval-timing",
  durationS: "eval-duration",
  opensAt: "eval-opens-at",
  closesAt: "eval-closes-at",
};

/** What to do about each missing field, in the teacher's words. */
export function missingTimingKey(field: TimingField): keyof Dict {
  return `eval.missing.${field}`;
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
