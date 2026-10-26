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
 *
 * A draft's window is not a fact yet (#921): its sentence says "once open"
 * rather than "open until", which read as a promise the badge contradicted.
 */
import type { Evaluation } from "@quiz/contracts";
import { clockChoiceOf } from "@quiz/domain";

import type { Dict, TFunction } from "../i18n";

/** `closesAt` and `state` are an evaluation's only: a template has no dates, so no end yet. */
type SummaryInput = Pick<Evaluation, "settings" | "durationS" | "feedbackPolicy"> &
  Partial<Pick<Evaluation, "closesAt" | "state">>;

const WINDOW = {
  deadline: "eval.summary.deadline",
  manual: "eval.summary.manual",
  manualBackstop: "eval.summary.manualBackstop",
} as const satisfies Record<string, keyof Dict>;
const DRAFT_WINDOW = {
  deadline: "eval.summary.deadline.draft",
  manual: "eval.summary.manual.draft",
  manualBackstop: "eval.summary.manualBackstop.draft",
} as const satisfies Record<string, keyof Dict>;

/**
 * The window's words: the Scheduled clock's end, or Live's close by the
 * teacher (and its safety deadline), whatever the stored `timing` that is not
 * a duration. A draft's are conditional (#921).
 */
export function timingFragment(e: SummaryInput, t: TFunction, formatDate: (iso: string) => string): string {
  if (e.settings.timing === "duration") {
    if (e.durationS === null || e.durationS <= 0) return t("eval.summary.durationUnset");
    const n = Math.max(1, Math.round(e.durationS / 60));
    return n === 1 ? t("eval.summary.durationOne") : t("eval.summary.duration", { n });
  }
  const words = e.state === "draft" ? DRAFT_WINDOW : WINDOW;
  if (clockChoiceOf(e.settings).mode === "scheduled") {
    return e.closesAt == null
      ? t("eval.summary.deadlineUnset")
      : t(words.deadline, { date: formatDate(e.closesAt) });
  }
  return e.closesAt == null ? t(words.manual) : t(words.manualBackstop, { date: formatDate(e.closesAt) });
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
