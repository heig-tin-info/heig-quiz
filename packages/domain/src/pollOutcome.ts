/**
 * The outcome of a poll question over its recent runs (issue #161, ADR-014
 * addendum 2026-09-27): the small donut beside a row of the launcher's
 * "Recent polls" tab.
 *
 * Pure (invariant 8). The caller loads, per FINISHED run of the question,
 * how many answered, how many of those answers earned full marks, how many
 * people the run was addressed to, and whether the run had a key; this rule
 * decides what the row shows.
 *
 * The rules, in order:
 *   1. Runs arrive newest first. The KIND is that of the newest run: a
 *      question with a key is a donut, one without is "n answers". Runs of
 *      the other kind are dropped — a kept keyless question may gain a key
 *      later, and the opinions it collected then say nothing about who is
 *      right now.
 *   2. A keyed run the grading pass has not reached yet (`correct === null`)
 *      is not a result; it is dropped.
 *   3. The window is the last {@link POLL_OUTCOME_WINDOW} runs left.
 *   4. ABSTENTION needs a roster. It is shown only when EVERY run of the
 *      window has one (`roster !== null`: a poll that is not anonymous, in a
 *      classroom); a single anonymous run in the window folds the donut to
 *      correct / incorrect, measured over the answers. Mixing "share of the
 *      room" and "share of those who answered" in one average would be a
 *      number that means neither.
 *   5. With a roster, a run's denominator is `max(roster, answered)` — a
 *      teacher trying their own poll answers without a seat, and a share
 *      must never exceed the whole. Without one, it is `answered`. A run with
 *      a zero denominator has no rates and is left out of the average.
 *   6. The average is the MEAN OF THE PER-RUN RATES: every run weighs the
 *      same, a crowded lecture does not drown a small lab.
 */

/** How many recent runs the outcome averages over. */
export const POLL_OUTCOME_WINDOW = 5;

/** One finished run of a poll question, as the caller counted it. */
export interface PollRunCounts {
  /** The frozen version had a key (`hasKey`); false for an opinion poll. */
  keyed: boolean;
  /** Participants holding an answer. */
  answered: number;
  /** Answers with full marks; null when the run is not graded yet. Ignored when not keyed. */
  correct: number | null;
  /** The people the run was addressed to; null when it had no roster (anonymous). */
  roster: number | null;
}

/** Rates in [0, 1] and their whole percentages (largest remainder: they sum to 100). */
export interface PollOutcomeShare {
  rate: number;
  percent: number;
}

export type PollOutcome =
  /** Nothing to show: no finished run, or none with a denominator. */
  | { kind: "none" }
  /** No key: how many answered, on average per run (rounded). */
  | { kind: "opinion"; runs: number; answers: number }
  /** A key: the donut. `abstention` is null when the window has no roster throughout. */
  | {
      kind: "keyed";
      runs: number;
      correct: PollOutcomeShare;
      incorrect: PollOutcomeShare;
      abstention: PollOutcomeShare | null;
    };

/**
 * Whole percentages that sum to exactly 100 (when the rates sum to 1): each
 * floor, then the missing points to the largest remainders, ties to the
 * earlier part. A tooltip reading "33 % · 33 % · 33 %" is a question the
 * teacher should not have to ask.
 */
export function wholePercents(rates: readonly number[]): number[] {
  const scaled = rates.map((r) => Math.max(0, r) * 100);
  const floors = scaled.map((x) => Math.floor(x + 1e-9));
  const total = Math.round(scaled.reduce((a, b) => a + b, 0));
  let missing = total - floors.reduce((a, b) => a + b, 0);
  const order = scaled
    .map((x, i) => ({ i, rest: x - floors[i]! }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (missing <= 0) break;
    floors[i]! += 1;
    missing -= 1;
  }
  return floors;
}

const share = (rate: number, percent: number): PollOutcomeShare => ({ rate, percent });

export function pollOutcome(
  runsNewestFirst: readonly PollRunCounts[],
  window: number = POLL_OUTCOME_WINDOW,
): PollOutcome {
  const newest = runsNewestFirst[0];
  if (newest === undefined) return { kind: "none" };

  const sameKind = runsNewestFirst.filter((r) => r.keyed === newest.keyed);

  if (!newest.keyed) {
    const recent = sameKind.slice(0, window);
    const total = recent.reduce((sum, r) => sum + Math.max(0, r.answered), 0);
    return { kind: "opinion", runs: recent.length, answers: Math.round(total / recent.length) };
  }

  const recent = sameKind.filter((r) => r.correct !== null).slice(0, window);
  if (recent.length === 0) return { kind: "none" };
  const withRoster = recent.every((r) => r.roster !== null);

  let correct = 0;
  let incorrect = 0;
  let abstention = 0;
  let counted = 0;
  for (const run of recent) {
    const answered = Math.max(0, run.answered);
    const right = Math.min(Math.max(0, run.correct ?? 0), answered);
    const denominator = withRoster ? Math.max(run.roster ?? 0, answered) : answered;
    if (denominator === 0) continue;
    correct += right / denominator;
    incorrect += (answered - right) / denominator;
    abstention += (denominator - answered) / denominator;
    counted += 1;
  }
  if (counted === 0) return { kind: "none" };

  const rates = [correct / counted, incorrect / counted, abstention / counted];
  if (!withRoster) {
    const [c, i] = rates as [number, number, number];
    const [pc, pi] = wholePercents([c, i]) as [number, number];
    return {
      kind: "keyed",
      runs: counted,
      correct: share(c, pc),
      incorrect: share(i, pi),
      abstention: null,
    };
  }
  const [c, i, a] = rates as [number, number, number];
  const [pc, pi, pa] = wholePercents(rates) as [number, number, number];
  return {
    kind: "keyed",
    runs: counted,
    correct: share(c, pc),
    incorrect: share(i, pi),
    abstention: share(a, pa),
  };
}
