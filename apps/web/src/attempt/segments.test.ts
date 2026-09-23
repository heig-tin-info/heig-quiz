import { describe, expect, it, vi } from "vitest";

import type { Navigation } from "@quiz/contracts";

import { isAnswered } from "../student/QuestionHost";
import { segmentsOf, type PlayerItem, type PlayerState } from "./playerReducer";

/*
 * `segmentsOf`, the projection behind the progress strip. The four states
 * have a strict precedence — current > done > answered > empty — and none of
 * them depends on the navigation mode or on a lock: a locked question the
 * student already answered is still drawn "answered". Every mode is crossed
 * with every lock state so that a swapped branch goes red whichever one it is.
 */

const NAVIGATIONS: Navigation[] = ["free", "forward_only", "milestones"];

const item = (id: string, over: Partial<PlayerItem> = {}): PlayerItem => ({
  id,
  position: 0,
  points: 1,
  type: "short",
  milestone: false,
  markedDone: false,
  student: {},
  serverLocked: false,
  ...over,
});

/** "Answered" means a non-empty string here, so an empty string is a real "empty". */
const answered = (_type: string, answer: unknown) => typeof answer === "string" && answer !== "";

/**
 * Five questions, the student on the first one:
 *   i0 current (done AND answered — current still wins),
 *   i1 done AND answered (done wins), i2 answered, i3 empty string, i4 never opened.
 */
function state(navigation: Navigation, locked: boolean): PlayerState {
  return {
    navigation,
    index: 0,
    items: [
      item("i0", { markedDone: true, serverLocked: locked }),
      item("i1", { markedDone: true, serverLocked: locked }),
      item("i2", { serverLocked: locked }),
      item("i3", { serverLocked: locked }),
      item("i4", { serverLocked: locked }),
    ],
    answers: { i0: "x", i1: "y", i2: "z", i3: "" },
  };
}

const CASES = NAVIGATIONS.flatMap((navigation) =>
  [false, true].map((locked) => ({ navigation, locked })),
);

describe("segmentsOf", () => {
  it.each(CASES)("$navigation, locked=$locked: current > done > answered > empty", ({ navigation, locked }) => {
    expect(segmentsOf(state(navigation, locked), answered)).toEqual([
      { id: "i0", state: "current" },
      { id: "i1", state: "done" },
      { id: "i2", state: "answered" },
      { id: "i3", state: "empty" },
      { id: "i4", state: "empty" },
    ]);
  });

  it.each(CASES)("$navigation, locked=$locked: the current marker follows the index", ({ navigation, locked }) => {
    const s = { ...state(navigation, locked), index: 3 };
    expect(segmentsOf(s, answered).map((x) => x.state)).toEqual([
      "done",
      "done",
      "answered",
      "current",
      "empty",
    ]);
  });

  it("asks the predicate with the item's type and null for an unopened question", () => {
    const spy = vi.fn(() => false);
    const s: PlayerState = {
      navigation: "free",
      index: 0,
      items: [item("i0"), item("i1", { type: "mcq" }), item("i2", { type: "code" })],
      answers: { i1: { selected: [0] } },
    };
    segmentsOf(s, spy);
    // The current one is never asked: its segment is "current" whatever it holds.
    expect(spy.mock.calls).toEqual([
      ["mcq", { selected: [0] }],
      ["code", null],
    ]);
  });

  it("with the real isAnswered: an empty MCQ selection is empty, a choice is answered", () => {
    const s: PlayerState = {
      navigation: "free",
      index: 0,
      items: [item("i0"), item("i1", { type: "mcq" }), item("i2", { type: "mcq" })],
      answers: { i1: { selected: [2] }, i2: { selected: [] } },
    };
    expect(segmentsOf(s, isAnswered).map((x) => x.state)).toEqual(["current", "answered", "empty"]);
  });

  it("an empty attempt has an empty strip", () => {
    expect(segmentsOf({ navigation: "free", index: 0, items: [], answers: {} }, answered)).toEqual([]);
  });
});
