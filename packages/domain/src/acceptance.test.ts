import { describe, expect, it } from "vitest";

import { acceptanceReach, acceptanceScopes, holdsRule, rulesForAttempt } from "./acceptance.js";

describe("acceptanceScopes", () => {
  it("offers both scopes, and only one student for a parameterized question", () => {
    expect(acceptanceScopes(false)).toEqual(["everyone", "student"]);
    expect(acceptanceScopes(true)).toEqual(["student"]);
  });
});

describe("rulesForAttempt", () => {
  const rules = [
    { part: "b1", answer: "1", attemptId: null },
    { part: "b0", answer: "x", attemptId: "a" },
    { part: "b0", answer: "y", attemptId: "b" },
  ];

  it("takes the rules for everyone and the attempt's own", () => {
    expect(rulesForAttempt(rules, { id: "a", practice: false })).toEqual([
      { part: "b1", answer: "1" },
      { part: "b0", answer: "x" },
    ]);
  });

  it("gives a practice attempt none: it is graded against the pool's key", () => {
    expect(rulesForAttempt(rules, { id: "a", practice: true })).toEqual([]);
  });
});

describe("acceptanceReach", () => {
  const cells = [
    { attemptId: "a", given: [{ part: "b1", answer: "1" }], manual: false },
    { attemptId: "b", given: [{ part: "b1", answer: "1" }], manual: true },
    { attemptId: "c", given: [{ part: "b1", answer: "2" }], manual: false },
    { attemptId: "d", given: [{ part: "b0", answer: "1" }], manual: false },
  ];

  it("reaches everyone who gave the answer at that part, a manual override left unchanged", () => {
    expect(acceptanceReach(cells, { part: "b1", answer: "1", attemptId: null })).toEqual({
      reached: ["a"],
      unchanged: ["b"],
    });
  });

  it("reaches one attempt only in the student scope", () => {
    expect(acceptanceReach(cells, { part: "b1", answer: "1", attemptId: "b" })).toEqual({
      reached: [],
      unchanged: ["b"],
    });
    expect(acceptanceReach(cells, { part: "b1", answer: "1", attemptId: "c" })).toEqual({
      reached: [],
      unchanged: [],
    });
  });
});

describe("holdsRule", () => {
  it("compares part, answer and scope", () => {
    const rules = [{ part: "b1", answer: "1", attemptId: null }];
    expect(holdsRule(rules, { part: "b1", answer: "1", attemptId: null })).toBe(true);
    expect(holdsRule(rules, { part: "b1", answer: "1", attemptId: "a" })).toBe(false);
  });
});
