import { describe, expect, it } from "vitest";

import {
  answerMark,
  countsAsCompleted,
  isSettled,
  lockedItems,
  mayValidate,
  maySkip,
  progressStatus,
} from "./questionProgress.js";

describe("answerMark", () => {
  it("reads answered, skipped and unanswered", () => {
    expect(answerMark({ answered: true, skipped: false })).toBe("answered");
    expect(answerMark({ answered: false, skipped: true })).toBe("skipped");
    expect(answerMark({ answered: false, skipped: false })).toBe("unanswered");
  });

  it("lets an answer win over a stale skip", () => {
    expect(answerMark({ answered: true, skipped: true })).toBe("answered");
  });

  it("counts both answered and skipped as settled", () => {
    expect(isSettled({ answered: true, skipped: false })).toBe(true);
    expect(isSettled({ answered: false, skipped: true })).toBe(true);
    expect(isSettled({ answered: false, skipped: false })).toBe(false);
  });
});

describe("maySkip", () => {
  it("is offered only on an empty question", () => {
    expect(maySkip({ answered: false })).toBe(true);
    expect(maySkip({ answered: true })).toBe(false);
  });
});

describe("mayValidate", () => {
  it("is every question in forward_only, the checkpoints in milestones, none in free", () => {
    expect(mayValidate("forward_only", { milestone: false })).toBe(true);
    expect(mayValidate("milestones", { milestone: true })).toBe(true);
    expect(mayValidate("milestones", { milestone: false })).toBe(false);
    expect(mayValidate("free", { milestone: true })).toBe(false);
  });
});

describe("lockedItems", () => {
  const items = [
    { id: "a", milestone: false, validated: true },
    { id: "b", milestone: true, validated: false },
    { id: "c", milestone: false, validated: false },
    { id: "d", milestone: true, validated: true },
    { id: "e", milestone: false, validated: false },
  ];

  it("locks nothing in free", () => {
    expect(lockedItems("free", items).size).toBe(0);
  });

  it("locks the validated questions in forward_only", () => {
    expect([...lockedItems("forward_only", items)]).toEqual(["a", "d"]);
  });

  it("locks everything up to the furthest validated checkpoint in milestones", () => {
    expect([...lockedItems("milestones", items)]).toEqual(["a", "b", "c", "d"]);
  });

  it("ignores a validated question that is not a checkpoint in milestones", () => {
    expect(lockedItems("milestones", [items[0]!, items[1]!]).size).toBe(0);
  });
});

describe("progressStatus", () => {
  const base = { row: true, answered: false, skipped: false, validated: false };

  it("is empty without a row, seen with an empty one", () => {
    expect(progressStatus({ ...base, row: false })).toBe("empty");
    expect(progressStatus(base)).toBe("seen");
  });

  it("reads answered, skipped and validated", () => {
    expect(progressStatus({ ...base, answered: true })).toBe("in_progress");
    expect(progressStatus({ ...base, skipped: true })).toBe("skipped");
    expect(progressStatus({ ...base, answered: true, validated: true })).toBe("done");
  });

  it("counts answered, skipped and validated toward completion, never seen", () => {
    expect(countsAsCompleted("in_progress")).toBe(true);
    expect(countsAsCompleted("skipped")).toBe(true);
    expect(countsAsCompleted("done")).toBe(true);
    expect(countsAsCompleted("seen")).toBe(false);
    expect(countsAsCompleted("empty")).toBe(false);
  });
});
