import { describe, expect, it } from "vitest";

import { POLL_OUTCOME_WINDOW, pollOutcome, wholePercents, type PollRunCounts } from "./pollOutcome.js";

const keyed = (answered: number, correct: number | null, roster: number | null): PollRunCounts => ({
  keyed: true,
  answered,
  correct,
  roster,
});
const opinion = (answered: number, roster: number | null = null): PollRunCounts => ({
  keyed: false,
  answered,
  correct: null,
  roster,
});

describe("wholePercents", () => {
  it("sums to 100 by largest remainder, ties to the earlier part", () => {
    expect(wholePercents([1 / 3, 1 / 3, 1 / 3])).toEqual([34, 33, 33]);
    expect(wholePercents([0.125, 0.875])).toEqual([13, 87]);
    expect(wholePercents([0.5, 0.5, 0])).toEqual([50, 50, 0]);
  });

  it("keeps exact values exact", () => {
    expect(wholePercents([0.25, 0.25, 0.5])).toEqual([25, 25, 50]);
    expect(wholePercents([1, 0])).toEqual([100, 0]);
  });
});

describe("pollOutcome", () => {
  it("shows nothing for a question that never finished a run", () => {
    expect(pollOutcome([])).toEqual({ kind: "none" });
  });

  it("classroom poll: correct / incorrect / abstention against the roster", () => {
    const outcome = pollOutcome([keyed(15, 9, 20)]);
    expect(outcome).toMatchObject({
      kind: "keyed",
      runs: 1,
      correct: { rate: 0.45, percent: 45 },
      incorrect: { rate: 0.3, percent: 30 },
      abstention: { rate: 0.25, percent: 25 },
    });
  });

  it("anonymous poll: correct / incorrect over the answers, no abstention", () => {
    const outcome = pollOutcome([keyed(8, 6, null)]);
    expect(outcome).toMatchObject({
      kind: "keyed",
      correct: { rate: 0.75, percent: 75 },
      incorrect: { rate: 0.25, percent: 25 },
      abstention: null,
    });
  });

  it("opinion poll: no donut, the answers per run", () => {
    expect(pollOutcome([opinion(12), opinion(9, 30)])).toEqual({
      kind: "opinion",
      runs: 2,
      answers: 11,
    });
  });

  it("averages the per-run rates, every run weighing the same", () => {
    // 10/10 correct in a small lab, 0/90 in a crowded lecture: 50 %, not 10 %.
    const outcome = pollOutcome([keyed(10, 10, null), keyed(90, 0, null)]);
    expect(outcome).toMatchObject({
      runs: 2,
      correct: { rate: 0.5, percent: 50 },
      incorrect: { rate: 0.5, percent: 50 },
    });
  });

  it(`keeps the last ${POLL_OUTCOME_WINDOW} runs only`, () => {
    const recent = Array.from({ length: POLL_OUTCOME_WINDOW }, () => keyed(4, 4, null));
    const outcome = pollOutcome([...recent, keyed(4, 0, null), keyed(4, 0, null)]);
    expect(outcome).toMatchObject({ runs: POLL_OUTCOME_WINDOW, correct: { percent: 100 } });
  });

  it("drops a run the grading pass has not reached, and does not let it use a window slot", () => {
    const runs = [keyed(5, null, null), ...Array.from({ length: 5 }, () => keyed(2, 1, null))];
    expect(pollOutcome(runs)).toMatchObject({ runs: 5, correct: { percent: 50 } });
    expect(pollOutcome([keyed(5, null, 10)])).toEqual({ kind: "none" });
  });

  it("folds out abstention as soon as one run of the window had no roster", () => {
    const outcome = pollOutcome([keyed(10, 5, 20), keyed(4, 4, null)]);
    expect(outcome).toMatchObject({
      abstention: null,
      correct: { rate: 0.75 },
      incorrect: { rate: 0.25 },
    });
  });

  it("never lets a share exceed the whole when more answer than the roster holds", () => {
    const outcome = pollOutcome([keyed(12, 12, 10)]);
    expect(outcome).toMatchObject({
      correct: { rate: 1, percent: 100 },
      abstention: { rate: 0, percent: 0 },
    });
  });

  it("counts a classroom poll nobody answered as full abstention", () => {
    expect(pollOutcome([keyed(0, 0, 18)])).toMatchObject({
      abstention: { rate: 1, percent: 100 },
    });
  });

  it("leaves out a run with no denominator, and shows nothing if none is left", () => {
    expect(pollOutcome([keyed(0, 0, null)])).toEqual({ kind: "none" });
    expect(pollOutcome([keyed(0, 0, null), keyed(2, 2, null)])).toMatchObject({
      runs: 1,
      correct: { percent: 100 },
    });
  });

  it("follows the newest run's kind: a keyless question that gained a key is a donut", () => {
    expect(pollOutcome([keyed(4, 1, null), opinion(30), opinion(30)])).toMatchObject({
      kind: "keyed",
      runs: 1,
      correct: { percent: 25 },
    });
    expect(pollOutcome([opinion(3), keyed(4, 1, null)])).toEqual({
      kind: "opinion",
      runs: 1,
      answers: 3,
    });
  });

  it("clamps a correct count above the answers", () => {
    expect(pollOutcome([keyed(2, 5, null)])).toMatchObject({ correct: { rate: 1 } });
  });

  it("always sums the percentages to 100", () => {
    const outcome = pollOutcome([keyed(3, 1, 7), keyed(5, 2, 9), keyed(1, 1, 3)]);
    if (outcome.kind !== "keyed") throw new Error("expected a donut");
    const sum = outcome.correct.percent + outcome.incorrect.percent + (outcome.abstention?.percent ?? 0);
    expect(sum).toBe(100);
  });
});
