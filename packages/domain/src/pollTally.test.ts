import { describe, expect, it } from "vitest";

import { foldPollAnswer, pollTally } from "./pollTally.js";

describe("pollTally — mcq", () => {
  it("emits one entry per canonical choice, in order, zeroes included", () => {
    const tally = pollTally({
      type: "mcq",
      choiceCount: 4,
      joined: 3,
      payloads: [{ selected: [0] }, { selected: [2] }, { selected: [0] }],
    });
    expect(tally.choices).toEqual([
      { index: 0, count: 2 },
      { index: 1, count: 0 },
      { index: 2, count: 1 },
      { index: 3, count: 0 },
    ]);
    expect(tally).toMatchObject({ joined: 3, answered: 3, answers: [] });
  });

  it("counts every selected index of a multiple answer, once each", () => {
    const tally = pollTally({
      type: "mcq",
      choiceCount: 3,
      joined: 1,
      payloads: [{ selected: [0, 2, 2] }],
    });
    expect(tally.choices.map((c) => c.count)).toEqual([1, 0, 1]);
    expect(tally.answered).toBe(1);
  });

  it("ignores an out-of-range index and an unreadable payload", () => {
    const tally = pollTally({
      type: "mcq",
      choiceCount: 2,
      joined: 4,
      payloads: [{ selected: [5] }, { selected: "1" }, null, { selected: [1] }],
    });
    expect(tally.choices.map((c) => c.count)).toEqual([0, 1]);
    // Only the last payload selected anything countable.
    expect(tally.answered).toBe(1);
  });
});

describe("pollTally — short", () => {
  it("folds the spellings and keeps the first one seen", () => {
    const tally = pollTally({
      type: "short",
      choiceCount: 0,
      joined: 4,
      payloads: [{ text: "Paris" }, { text: " paris " }, { text: "PARIS" }, { text: "Lyon" }],
    });
    expect(tally.answers).toEqual([
      { text: "Paris", count: 3 },
      { text: "Lyon", count: 1 },
    ]);
    expect(tally.answered).toBe(4);
  });

  it("collapses the inner whitespace of the folding key", () => {
    const tally = pollTally({
      type: "short",
      choiceCount: 0,
      joined: 2,
      payloads: [{ text: "int  main" }, { text: "int main" }],
    });
    expect(tally.answers).toEqual([{ text: "int  main", count: 2 }]);
  });

  it("orders by frequency, ties by first appearance", () => {
    const tally = pollTally({
      type: "short",
      choiceCount: 0,
      joined: 3,
      payloads: [{ text: "b" }, { text: "a" }, { text: "a" }, { text: "c" }],
    });
    expect(tally.answers.map((a) => a.text)).toEqual(["a", "b", "c"]);
  });

  it("does not count an empty answer", () => {
    const tally = pollTally({
      type: "short",
      choiceCount: 0,
      joined: 3,
      payloads: [{ text: "   " }, { text: "" }, { text: "x" }],
    });
    expect(tally.answered).toBe(1);
    expect(tally.answers).toEqual([{ text: "x", count: 1 }]);
  });

  it("caps the number of distinct answers", () => {
    const payloads = Array.from({ length: 10 }, (_, i) => ({ text: `answer-${i}` }));
    const tally = pollTally({ type: "short", choiceCount: 0, joined: 10, payloads, shortCap: 3 });
    expect(tally.answers).toHaveLength(3);
    // The cap never hides the true count of answers received.
    expect(tally.answered).toBe(10);
  });
});

describe("foldPollAnswer", () => {
  it("is stable under case, accents kept, spaces collapsed", () => {
    expect(foldPollAnswer("  Élève   A ")).toBe("élève a");
    expect(foldPollAnswer("ÉLÈVE A")).toBe(foldPollAnswer("élève a"));
  });
});
