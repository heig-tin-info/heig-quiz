/**
 * The three MCQ scoring policies (docs/04 §4.4, PLAN-MVP §2.1 and §7.3).
 *
 *   C = number of correct choices, W = number of incorrect ones
 *   c = correct choices selected,  w = incorrect ones selected
 *
 *   all_or_nothing : f = (c === C && w === 0) ? 1 : 0
 *   partial        : f = (c - w) / C
 *   penalized      : f = c / C - penalty * (W > 0 ? w / W : 0)
 *
 * then clamped into `[allowNegative ? -1 : 0, 1]`.
 */
import { clamp } from "./round.js";

export type McqPolicy = "all_or_nothing" | "partial" | "penalized";

export interface McqScoreInput {
  /** Canonical indices of the correct choices. */
  correct: readonly number[];
  /** Canonical indices the student selected. */
  selected: readonly number[];
  choiceCount: number;
  policy: McqPolicy;
  penalty: number;
  allowNegative: boolean;
}

export interface McqScore {
  fraction: number;
  c: number;
  w: number;
  C: number;
  W: number;
}

export function mcqFraction(input: McqScoreInput): McqScore {
  const correct = new Set(input.correct);
  const selected = new Set(input.selected);
  const C = correct.size;
  const W = Math.max(0, input.choiceCount - C);
  let c = 0;
  for (const i of selected) if (correct.has(i)) c++;
  const w = selected.size - c;

  // C === 0 is refused by the config schema; staying total here keeps a
  // corrupted row from throwing inside the grading worker.
  if (C === 0) return { fraction: 0, c, w, C, W };

  const raw =
    input.policy === "all_or_nothing"
      ? c === C && w === 0
        ? 1
        : 0
      : input.policy === "partial"
        ? (c - w) / C
        : c / C - input.penalty * (W > 0 ? w / W : 0);

  return { fraction: clamp(raw, input.allowNegative ? -1 : 0, 1), c, w, C, W };
}

/**
 * `maxSelections` is a player-side guard: a payload that exceeds it is
 * truncated server-side and the truncation is reported in the details. An
 * answer is never hard-rejected (F-LIVE: never lose an answer).
 */
export function truncateSelection(
  selected: readonly number[],
  maxSelections: number | null,
): { selected: number[]; truncated: boolean } {
  const unique = [...new Set(selected)].sort((a, b) => a - b);
  if (maxSelections === null || unique.length <= maxSelections) {
    return { selected: unique, truncated: false };
  }
  return { selected: unique.slice(0, maxSelections), truncated: true };
}
