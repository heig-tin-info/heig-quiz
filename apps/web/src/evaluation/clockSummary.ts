/*
 * What the card of the mode in force says (#87, ADR-086): one sentence built
 * from the values in force, so it can never contradict the settings under
 * it. A teacher who picks Live and then sets 30 minutes reads "30 minutes
 * each", not a default.
 *
 * Only the decisions a teacher reads off the card are named — the time, the
 * waiting room (Live only: Scheduled has none, its name says so), the
 * navigation and when the feedback comes — in that order, each a translated
 * fragment; the sentence is the fragments joined by commas, which reads the
 * same in English and in French.
 */
import type { Evaluation } from "@quiz/contracts";
import { clockChoiceOf } from "@quiz/domain";

import type { Dict, TFunction } from "../i18n";

/** `closesAt` is an evaluation's only: a template has no dates, so no end yet. */
type SummaryInput = Pick<Evaluation, "settings" | "durationS" | "feedbackPolicy"> &
  Partial<Pick<Evaluation, "closesAt">>;

export function timingFragment(e: SummaryInput, t: TFunction, formatDate: (iso: string) => string): string {
  switch (e.settings.timing) {
    case "duration": {
      if (e.durationS === null || e.durationS <= 0) return t("eval.summary.durationUnset");
      const n = Math.max(1, Math.round(e.durationS / 60));
      return n === 1 ? t("eval.summary.durationOne") : t("eval.summary.duration", { n });
    }
    case "deadline":
      return e.closesAt == null
        ? t("eval.summary.deadlineUnset")
        : t("eval.summary.deadline", { date: formatDate(e.closesAt) });
    case "manual":
      return e.closesAt == null
        ? t("eval.summary.manual")
        : t("eval.summary.manualBackstop", { date: formatDate(e.closesAt) });
  }
}

export function clockSummary(
  e: SummaryInput,
  t: TFunction,
  formatDate: (iso: string) => string,
): string {
  const live = clockChoiceOf(e.settings).mode === "live";
  const sentence = [
    timingFragment(e, t, formatDate),
    ...(live ? [t(`eval.summary.lobby.${e.settings.lobby}` as keyof Dict)] : []),
    t(`eval.summary.navigation.${e.settings.navigation}` as keyof Dict),
    t(`eval.summary.feedback.${e.feedbackPolicy.when}` as keyof Dict),
  ].join(", ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
