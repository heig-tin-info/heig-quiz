/*
 * What the card of the MATCHED preset says (#87): one sentence built from the
 * values in force, so it can never contradict the settings under it. A
 * teacher who picks "In class" and then sets 30 minutes reads "30 minutes
 * each", not the 45 the preset once wrote.
 *
 * Only the decisions a preset is about are named — the timing, the waiting
 * room, the navigation and when the feedback comes — in that order, each a
 * translated fragment; the sentence is the fragments joined by commas, which
 * reads the same in English and in French.
 */
import type { Evaluation } from "@quiz/contracts";

import type { Dict, TFunction } from "../i18n";

type SummaryInput = Pick<Evaluation, "settings" | "durationS" | "closesAt" | "feedbackPolicy">;

function timingFragment(e: SummaryInput, t: TFunction, formatDate: (iso: string) => string): string {
  switch (e.settings.timing) {
    case "duration": {
      if (e.durationS === null || e.durationS <= 0) return t("eval.summary.durationUnset");
      const n = Math.max(1, Math.round(e.durationS / 60));
      return n === 1 ? t("eval.summary.durationOne") : t("eval.summary.duration", { n });
    }
    case "deadline":
      return e.closesAt === null
        ? t("eval.summary.deadlineUnset")
        : t("eval.summary.deadline", { date: formatDate(e.closesAt) });
    case "manual":
      return t("eval.summary.manual");
  }
}

export function presetSummary(
  e: SummaryInput,
  t: TFunction,
  formatDate: (iso: string) => string,
): string {
  const sentence = [
    timingFragment(e, t, formatDate),
    t(`eval.summary.lobby.${e.settings.lobby}` as keyof Dict),
    t(`eval.summary.navigation.${e.settings.navigation}` as keyof Dict),
    t(`eval.summary.feedback.${e.feedbackPolicy.when}` as keyof Dict),
  ].join(", ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
