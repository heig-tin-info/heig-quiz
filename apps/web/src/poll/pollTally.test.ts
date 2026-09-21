import { describe, expect, it } from "vitest";

import type { PollTally, PollTeacherView } from "@quiz/contracts";

import {
  joinHost,
  letterOf,
  percentOf,
  pollRows,
  promptOf,
  questionScale,
  waitingOf,
} from "./pollTally";

/*
 * The join the projection stands on: the tally is indexed by the CANONICAL
 * choice, the student view is in the SERVED order, and the letter on the wall
 * is the position on screen. Get any of the three wrong and a lecture hall
 * reads the wrong bar as the right answer, which is exactly the kind of bug a
 * beamer hides.
 */

const tally = (patch: Partial<PollTally> = {}): PollTally => ({
  joined: 0,
  answered: 0,
  choices: [],
  answers: [],
  ...patch,
});

const mcq = (
  choices: { id: number; text: string }[],
  correct: number[],
): PollTeacherView["question"] => ({
  id: "q",
  type: "mcq",
  student: { prompt: "How many bytes?", choices, mode: "single" },
  solution: { correct },
});

describe("pollRows — mcq", () => {
  it("reads the counts through the canonical index, in the served order", () => {
    // Served shuffled: the room saw choice 2 first. Its count must follow it.
    const question = mcq(
      [
        { id: 2, text: "eight" },
        { id: 0, text: "four" },
        { id: 1, text: "two" },
      ],
      [2],
    );
    const rows = pollRows(
      question,
      tally({
        joined: 10,
        answered: 8,
        choices: [
          { index: 0, count: 2 },
          { index: 1, count: 2 },
          { index: 2, count: 4 },
        ],
      }),
    );
    expect(rows.map((r) => [r.letter, r.label, r.count, r.percent, r.correct])).toEqual([
      ["A", "eight", 4, 50, true],
      ["B", "four", 2, 25, false],
      ["C", "two", 2, 25, false],
    ]);
  });

  it("keeps a choice nobody picked, at zero", () => {
    const rows = pollRows(
      mcq(
        [
          { id: 0, text: "a" },
          { id: 1, text: "b" },
        ],
        [0],
      ),
      tally({ joined: 3, answered: 1, choices: [{ index: 0, count: 1 }] }),
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ count: 0, percent: 0 });
  });
});

describe("pollRows — short", () => {
  const question = (expected: string[]): PollTeacherView["question"] => ({
    id: "q",
    type: "short",
    student: { prompt: "Complexity?" },
    solution: { expected },
  });

  it("marks an accepted answer however it was spelt", () => {
    const rows = pollRows(
      question(["O(log n)"]),
      tally({
        joined: 12,
        answered: 10,
        answers: [
          { text: "  o(LOG   n) ", count: 6 },
          { text: "O(n)", count: 4 },
        ],
      }),
    );
    expect(rows[0]).toMatchObject({ correct: true, percent: 60, letter: null, markdown: false });
    expect(rows[1]).toMatchObject({ correct: false, percent: 40 });
  });

  it("leaves the server's order alone", () => {
    const rows = pollRows(
      question([]),
      tally({
        answered: 3,
        answers: [
          { text: "b", count: 2 },
          { text: "a", count: 1 },
        ],
      }),
    );
    expect(rows.map((r) => r.label)).toEqual(["b", "a"]);
  });
});

describe("the arithmetic of the wall", () => {
  it("counts percentages out of the ANSWERS, and survives none", () => {
    expect(percentOf(14, 52)).toBe(27);
    expect(percentOf(3, 0)).toBe(0);
  });

  it("lets a multiple-choice sum pass 100 % rather than lying about it", () => {
    expect(percentOf(8, 10) + percentOf(7, 10)).toBe(150);
  });

  it("never shows a negative queue", () => {
    expect(waitingOf(tally({ joined: 61, answered: 52 }))).toBe(9);
    expect(waitingOf(tally({ joined: 3, answered: 5 }))).toBe(0);
  });

  it("steps the question down as it gets longer, rather than pushing the bars off the wall", () => {
    const short = questionScale("How many bytes is a pointer?");
    const medium = questionScale("x".repeat(100));
    const long = questionScale("x".repeat(300));
    expect(short).toContain("68px");
    expect(medium).toContain("50px");
    expect(long).toContain("38px");
    expect(new Set([short, medium, long]).size).toBe(3);
  });

  it("letters the rows A, B, C…", () => {
    expect([0, 1, 25].map(letterOf)).toEqual(["A", "B", "Z"]);
  });
});

describe("the strings around the tally", () => {
  it("takes the prompt from whichever student view it got", () => {
    expect(promptOf(mcq([], []))).toBe("How many bytes?");
    expect(promptOf({ id: "q", type: "short", student: null, solution: null })).toBe("");
  });

  it("prints the host a participant types, and never throws on a bad URL", () => {
    expect(joinHost("https://quiz.heig-vd.ch/p/QZ4F7K")).toBe("quiz.heig-vd.ch");
    expect(joinHost("http://localhost:5173/p/QZ4F7K")).toBe("localhost:5173");
    expect(joinHost("not a url")).toBe("not a url");
  });
});
