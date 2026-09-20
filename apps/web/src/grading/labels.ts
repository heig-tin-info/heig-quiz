import type {
  Grading,
  GradingConfidence,
  GradingEntry,
  GradingSource,
  GradingState,
} from "@quiz/contracts";

import type { Dict, TFunction } from "../i18n";
import type { Tone, VerdictState } from "../ui";

/**
 * The words and tones the grading list puts on a cell. Kept out of the
 * components so the same badge reads the same in the list, in the detail and
 * in the history.
 */

const SOURCE_KEYS: Record<GradingSource, keyof Dict> = {
  auto: "grading.source.auto",
  llm: "grading.source.llm",
  manual: "grading.source.manual",
};

const CONFIDENCE_KEYS: Record<GradingConfidence, keyof Dict> = {
  low: "grading.confidence.low",
  medium: "grading.confidence.medium",
  high: "grading.confidence.high",
};

const STATE_KEYS: Record<GradingState, keyof Dict> = {
  proposed: "grading.state.proposed",
  validated: "grading.state.validated",
  superseded: "grading.state.superseded",
};

export const sourceLabel = (t: TFunction, s: GradingSource) => t(SOURCE_KEYS[s]);
export const confidenceLabel = (t: TFunction, c: GradingConfidence) => t(CONFIDENCE_KEYS[c]);
export const stateLabel = (t: TFunction, s: GradingState) => t(STATE_KEYS[s]);

/** Low confidence is the one that asks for eyes, so it is the only warm tone. */
export const confidenceTone = (c: GradingConfidence): Tone =>
  c === "low" ? "amber" : c === "high" ? "green" : "zinc";

/** A manual grading is the teacher's own: it wears the accent, never a status colour. */
export const sourceTone = (s: GradingSource): Tone => (s === "manual" ? "accent" : "zinc");

export const stateTone = (s: GradingState): Tone =>
  s === "validated" ? "green" : s === "proposed" ? "amber" : "zinc";

/**
 * The same rule as `verdictOf` in the API's grading service, with the one
 * case the server does not have to name: a cell with no answer at all is
 * blank, not wrong. It is graded zero either way (F-GRADE-01), but a teacher
 * scanning the list must be able to tell "answered badly" from "not there".
 */
export function entryVerdict(entry: Pick<GradingEntry, "answerId" | "answer" | "grading">): VerdictState {
  if (entry.answerId === null && entry.answer === null) return "blank";
  const grading = entry.grading;
  if (!grading || grading.state === "proposed") return "pending";
  if (grading.maxPoints > 0 && grading.points >= grading.maxPoints) return "correct";
  return grading.points > 0 ? "partial" : "wrong";
}

/** "4.5 / 6" — tabular, one decimal at most, never a bare percentage. */
export function scoreText(t: TFunction, grading: Grading | null, maxPoints?: number): string {
  if (!grading) return t("grading.notGraded");
  return t("grading.score", {
    points: round2(grading.points),
    max: round2(maxPoints ?? grading.maxPoints),
  });
}

/** Two decimals at most, with no trailing zeroes: points are not money. */
export function round2(n: number): string {
  return String(Math.round(n * 100) / 100);
}
