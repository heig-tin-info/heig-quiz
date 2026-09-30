import { describe, expect, it } from "vitest";

import {
  EVALUATION_STATES,
  isEvaluationOver,
  itemListLock,
  type EvaluationStateName,
} from "./itemList.js";

describe("itemListLock (issue #79)", () => {
  it("leaves the list editable only before the evaluation is opened, with no attempt", () => {
    const editable = EVALUATION_STATES.filter((s) => itemListLock(s, 0) === null);
    expect(editable).toEqual(["draft", "scheduled"]);
  });

  it("freezes it from the lobby on, even while nobody has entered", () => {
    const opened: EvaluationStateName[] = [
      "lobby",
      "running",
      "paused",
      "closed",
      "grading",
      "released",
    ];
    for (const state of opened) {
      expect(itemListLock(state, 0), state).toBe("opened");
    }
  });

  it("freezes it as soon as an attempt exists, whatever the state", () => {
    for (const state of EVALUATION_STATES) {
      expect(itemListLock(state, 1), state).toBe("attempts");
      expect(itemListLock(state, 3), state).toBe("attempts");
    }
  });

  it("says nothing when the list is editable", () => {
    expect(itemListLock("draft", 0)).toBeNull();
    expect(itemListLock("scheduled", 0)).toBeNull();
  });
});

describe("isEvaluationOver (ADR-033)", () => {
  it("holds from the close on, and never before", () => {
    expect(EVALUATION_STATES.filter(isEvaluationOver)).toEqual(["closed", "grading", "released"]);
  });
});
