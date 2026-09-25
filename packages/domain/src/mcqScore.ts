/**
 * The five MCQ scoring policies (docs/04 §4.4, PLAN-MVP §2.1 and §7.3).
 *
 * This module is the REFERENCE for what each policy means; the help topic
 * `mcq-policies` paraphrases it for the teacher, and `packages/qt-mcq` only
 * maps an answer onto it. Notation, for one `multiple` question:
 *
 *   C = number of correct choices ("the key"), W = number of distractors
 *   n = C + W = the number of choices
 *   c = correct choices the student ticked, w = distractors they ticked
 *
 * A `single` question is always scored `all_or_nothing`, whatever the
 * configuration says: with one key there is nothing to be partial about.
 *
 * `all_or_nothing` — the exact key set, or nothing.
 *
 *     f = (c === C && w === 0) ? 1 : 0
 *
 *   The default, and the only one a student never has to be told about.
 *
 * `true_false` — Multiple True-False: every choice is an independent
 *   true/false item, and the mark is the share of choices answered right. A
 *   correct choice left unticked and a distractor ticked cost the same.
 *
 *     f = (c + (W - w)) / n
 *
 *   Ticking nothing already scores W/n, which is why it suits a question
 *   whose choices are genuinely independent statements rather than one whose
 *   distractors are obvious.
 *
 * `discordance` — the French medical QRM convention. `d` is the Hamming
 *   distance between the ticked set and the key: the number of choices the
 *   student got the wrong way round, in either direction.
 *
 *     d = (C - c) + w
 *     f = d === 0 ? 1 : d === 1 ? 0.5 : d === 2 ? 0.2 : 0
 *
 *   One discordance still earns half the points, two earn a fifth, three
 *   earn nothing: it rewards an almost-right answer without paying for a
 *   nearly-random one.
 *
 * `symmetric` — the zero-expectation policy: a correct tick is worth 1/C, a
 *   wrong tick costs 1/W, so ticking at random has an expected value of 0.
 *
 *     f = c/C - w/W        (W = 0: f = c/C)
 *
 *   Floored at 0, so a bad answer is never worth less than no answer.
 *
 * `ripkey` — proportional credit, cancelled by any mistake.
 *
 *     f = w > 0 ? 0 : c/C
 *
 *   A student who ticks only what they are sure of is paid for it; one wrong
 *   tick voids the question.
 *
 * Every policy returns a fraction in [0, 1]. There is no penalty factor and
 * no negative score: a question is never worth less than not answering it.
 *
 * NEGATIVE MARKING (ADR-026, #130) is not a sixth policy but a setting of the
 * EVALUATION (`settings.negativeMarking`). When it is on, every choice
 * question of that evaluation, single or multiple answer, is scored with one
 * rule, whatever its own policy says:
 *
 *     f = c/C - w/W        (W = 0: f = c/C), NOT floored, in [-1, 1]
 *
 *   For a `single` question (C = 1, W = n - 1) it reads: the key is +1, a
 *   distractor is -1/(n - 1). For a `multiple` one it is `symmetric` without
 *   its floor. Nothing selected is 0 — which is what "I won't answer" and
 *   "Clear" leave behind. Ticking at random has an expected value of 0
 *   (`mcqScore.test.ts` checks it by enumeration), so guessing buys nothing.
 *
 *   A question may then be worth LESS than not answering it; the evaluation's
 *   TOTAL never is: {@link attemptTotal} in `./grade.ts` floors it at 0.
 */
import { clamp } from "./round.js";

/**
 * The scoring formulas: the one list of their names. `@quiz/qt-mcq` derives
 * its schema from it; `@quiz/contracts` (which depends on no package) spells
 * the wire enum again, checked equal both ways in `apps/api` at compile time.
 */
export const MCQ_SCORE_POLICIES = [
  "all_or_nothing",
  "true_false",
  "discordance",
  "symmetric",
  "ripkey",
] as const;
export type McqScorePolicy = (typeof MCQ_SCORE_POLICIES)[number];

/** The fallback wherever no policy was expressed; `DEFAULT_MCQ_POLICY` of `@quiz/contracts` is checked equal. */
export const DEFAULT_MCQ_SCORE_POLICY = "all_or_nothing" satisfies McqScorePolicy;

export interface McqScoreInput {
  /** Canonical indices of the correct choices. */
  correct: readonly number[];
  /** Canonical indices the student selected. */
  selected: readonly number[];
  choiceCount: number;
  policy: McqScorePolicy;
  /**
   * The evaluation scores its choice questions with negative marking
   * (ADR-026): `policy` is then ignored and the fraction lies in [-1, 1].
   */
  negativeMarking?: boolean | undefined;
  /**
   * The question's mode. A `single` question answered with SEVERAL choices —
   * which the player cannot send and the answer write refuses — is WRONG,
   * whatever it holds: 0, or -1/(n - 1) under negative marking. Without this,
   * a crafted [key, distractor] would score 1 - 1/(n - 1) under negative
   * marking, better than an honest guess.
   */
  mode?: "single" | "multiple" | undefined;
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

  if (input.mode === "single" && selected.size > 1) {
    return { fraction: input.negativeMarking === true ? -1 / Math.max(1, W) : 0, c, w, C, W };
  }
  if (input.negativeMarking === true) {
    return { fraction: clamp(negativeFraction({ c, w, C, W }), -1, 1), c, w, C, W };
  }
  return { fraction: clamp(rawFraction(input.policy, { c, w, C, W }), 0, 1), c, w, C, W };
}

/**
 * The negative-marking rule (ADR-026): +1/C per key ticked, -1/W per
 * distractor ticked, not floored. With one key it is +1 for the key and
 * -1/(n - 1) for a distractor.
 */
function negativeFraction({ c, w, C, W }: { c: number; w: number; C: number; W: number }): number {
  return W === 0 ? c / C : c / C - w / W;
}

/** The formulas themselves, one line each, in the order of the doc comment. */
function rawFraction(
  policy: McqScorePolicy,
  { c, w, C, W }: { c: number; w: number; C: number; W: number },
): number {
  switch (policy) {
    case "all_or_nothing":
      return c === C && w === 0 ? 1 : 0;
    case "true_false":
      return (c + (W - w)) / (C + W);
    case "discordance": {
      const d = C - c + w;
      return d === 0 ? 1 : d === 1 ? 0.5 : d === 2 ? 0.2 : 0;
    }
    case "symmetric":
      return W === 0 ? c / C : c / C - w / W;
    case "ripkey":
      return w > 0 ? 0 : c / C;
  }
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
