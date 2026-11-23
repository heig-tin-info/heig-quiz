import { describe, expect, it, vi } from "vitest";

import type { Navigation } from "@quiz/contracts";

import { isAnswered } from "../student/QuestionHost";
import { segmentsOf, type PlayerItem, type PlayerState } from "./playerReducer";

/*
 * `segmentsOf`, the projection behind the student's question list (issue
 * #89). A segment carries FOUR independent facts — the mark (answered /
 * skipped / nothing yet), the flag, the lock and the position — and none of
 * them hides another: a question can be answered, flagged, closed and the
 * current one at once. The mark reads the ANSWER, never a click.
 */

const NAVIGATIONS: Navigation[] = ["free", "forward_only", "milestones"];

const item = (id: string, over: Partial<PlayerItem> = {}): PlayerItem => ({
  id,
  position: 0,
  points: 1,
  type: "short",
  milestone: false,
  counting: "normal",
  intro: null,
  markedDone: false,
  skipped: false,
  flagged: false,
  acquired: false,
  checked: false,
  correction: null,
  student: {},
  serverLocked: false,
  ...over,
});

/** "Answered" means a non-empty string here, so an empty string is a real "empty". */
const answered = (_type: string, answer: unknown) => typeof answer === "string" && answer !== "";

/**
 * Five questions, the student on the first one:
 *   i0 answered and flagged (current), i1 skipped and flagged,
 *   i2 answered AND a stale skip (the answer wins), i3 an empty string,
 *   i4 never opened.
 */
function state(navigation: Navigation, locked: boolean): PlayerState {
  return {
    navigation,
    index: 0,
    items: [
      item("i0", { flagged: true, serverLocked: locked }),
      item("i1", { skipped: true, flagged: true, serverLocked: locked }),
      item("i2", { skipped: true, serverLocked: locked }),
      item("i3", { serverLocked: locked }),
      item("i4", { serverLocked: locked }),
    ],
    answers: { i0: "x", i2: "z", i3: "" },
    passed: {},
  };
}

const CASES = NAVIGATIONS.flatMap((navigation) =>
  [false, true].map((locked) => ({ navigation, locked })),
);

describe("segmentsOf", () => {
  it.each(CASES)("$navigation, locked=$locked: every fact on its own field", ({ navigation, locked }) => {
    expect(segmentsOf(state(navigation, locked), answered)).toEqual([
      { id: "i0", mark: "answered", current: true, flagged: true, locked },
      { id: "i1", mark: "skipped", current: false, flagged: true, locked },
      { id: "i2", mark: "answered", current: false, flagged: false, locked },
      { id: "i3", mark: "unanswered", current: false, flagged: false, locked },
      { id: "i4", mark: "unanswered", current: false, flagged: false, locked },
    ]);
  });

  it.each(CASES)("$navigation, locked=$locked: the current marker follows the index", ({ navigation, locked }) => {
    const s = { ...state(navigation, locked), index: 3 };
    expect(segmentsOf(s, answered).map((x) => x.current)).toEqual([false, false, false, true, false]);
  });

  it("closes what the navigation closed, even before the server said so", () => {
    const s: PlayerState = {
      navigation: "forward_only",
      index: 1,
      items: [item("i0", { markedDone: true }), item("i1")],
      answers: {},
      passed: {},
    };
    expect(segmentsOf(s, answered).map((x) => x.locked)).toEqual([true, false]);
  });

  it("asks the predicate with the item's type and null for an unopened question", () => {
    const spy = vi.fn(() => false);
    const s: PlayerState = {
      navigation: "free",
      index: 0,
      items: [item("i0"), item("i1", { type: "mcq" }), item("i2", { type: "code" })],
      answers: { i1: { selected: [0] } },
      passed: {},
    };
    segmentsOf(s, spy);
    expect(spy.mock.calls).toEqual([
      ["short", null],
      ["mcq", { selected: [0] }],
      ["code", null],
    ]);
  });

  it("with the real isAnswered: an empty MCQ selection is not answered, a choice is", () => {
    const s: PlayerState = {
      navigation: "free",
      index: 0,
      items: [item("i0"), item("i1", { type: "mcq" }), item("i2", { type: "mcq" })],
      answers: { i1: { selected: [2] }, i2: { selected: [] } },
      passed: {},
    };
    expect(segmentsOf(s, isAnswered).map((x) => x.mark)).toEqual([
      "unanswered",
      "answered",
      "unanswered",
    ]);
  });

  describe("a text before a question (ADR-084)", () => {
    const intro = "Consignes générales.\n\n## Partie *2*\n\n```c\n# include\n```";
    const paper = (navigation: Navigation, index: number, passed: Record<string, true>): PlayerState => ({
      navigation,
      index,
      items: [item("i0"), item("i1", { intro }), item("i2", { intro: "Sans titre." })],
      answers: { i0: "x", i1: "y" },
      passed,
    });

    it("gets an entry before its question, titled by the first heading, with no mark of its own", () => {
      expect(segmentsOf(paper("free", 0, {}), answered)).toEqual([
        { id: "i0", mark: "answered", current: true, flagged: false, locked: false },
        { id: "intro:i1", mark: "unanswered", current: false, locked: false, passage: { title: "Partie 2" } },
        { id: "i1", mark: "answered", current: false, flagged: false, locked: false },
        { id: "intro:i2", mark: "unanswered", current: false, locked: false, passage: { title: null } },
        { id: "i2", mark: "unanswered", current: false, flagged: false, locked: false },
      ]);
    });

    it("is the current entry while the passage is on screen, its question once passed", () => {
      const current = (s: PlayerState) => segmentsOf(s, answered).filter((x) => x.current).map((x) => x.id);
      expect(current(paper("free", 1, {}))).toEqual(["intro:i1"]);
      expect(current(paper("free", 1, { i1: true }))).toEqual(["i1"]);
    });

    it("is closed once passed outside free navigation, never in free", () => {
      const lockOf = (navigation: Navigation) =>
        segmentsOf(paper(navigation, 2, { i1: true }), answered).find((x) => x.id === "intro:i1")?.locked;
      expect(lockOf("free")).toBe(false);
      expect(lockOf("forward_only")).toBe(true);
      expect(lockOf("milestones")).toBe(true);
    });
  });

  it("an empty attempt has an empty strip", () => {
    expect(segmentsOf({ navigation: "free", index: 0, items: [], answers: {}, passed: {} }, answered)).toEqual([]);
  });
});
