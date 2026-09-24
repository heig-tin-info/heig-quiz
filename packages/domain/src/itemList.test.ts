import { describe, expect, it } from "vitest";

import {
  EVALUATION_STATES,
  isItemListEditable,
  itemListLock,
  type EvaluationStateName,
} from "./itemList.js";

describe("itemListLock (issue #79)", () => {
  it("leaves the list editable only before the evaluation is opened, with no attempt", () => {
    const editable = EVALUATION_STATES.filter((s) => isItemListEditable(s, 0));
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
      expect(isItemListEditable(state, 0), state).toBe(false);
    }
  });

  it("freezes it as soon as an attempt exists, whatever the state", () => {
    for (const state of EVALUATION_STATES) {
      expect(itemListLock(state, 1), state).toBe("attempts");
      expect(isItemListEditable(state, 3), state).toBe(false);
    }
  });

  it("says nothing when the list is editable", () => {
    expect(itemListLock("draft", 0)).toBeNull();
    expect(itemListLock("scheduled", 0)).toBeNull();
  });
});
