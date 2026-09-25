import { describe, expect, it } from "vitest";

import type { AttemptView } from "@quiz/contracts";

import {
  canReach,
  currentItem,
  emptyPlayerState,
  isLocked,
  lockedIds,
  neighbour,
  playerReducer,
  type PlayerState,
} from "./playerReducer";

/*
 * The navigation rules, read here and in `lockedItemIds` of the live service
 * from ONE function (`@quiz/domain#lockedItems`). These tests are the client
 * half of that pair — same inputs, same answers, or a student is offered a
 * move the server answers with a 409.
 */

const item = (n: number, over: Partial<AttemptView["items"][number]> = {}) => ({
  id: `i${n}`,
  position: n,
  points: 1,
  type: "mcq",
  milestone: false,
  student: {},
  answer: null,
  revision: 0,
  markedDone: false,
  skipped: false,
  flagged: false,
  locked: false,
  ...over,
});

function view(
  navigation: "free" | "forward_only" | "milestones",
  items: AttemptView["items"],
  lastItemId: string | null = null,
): AttemptView {
  return {
    attempt: {
      id: "a1",
      state: "in_progress",
      startedAt: null,
      deadlineAt: null,
      lastItemId,
      serverNow: "2026-09-20T10:00:00.000Z",
      preview: false,
      readOnly: false,
    },
    evaluation: {
      id: "e1",
      title: "Quiz",
      mode: "exam",
      state: "running",
      settings: {
        navigation,
        presentation: "zen",
        lobby: "manual",
        shuffleItems: false,
        shuffleChoices: true,
        timing: "duration",
        showProgressBar: true,
        logVisibility: true,
        requireFullscreen: false,
      },
      feedbackPolicy: {
        when: "on_release",
        showAnswer: true,
        showKey: false,
        showExplanation: false,
        showHiddenCaseNames: true,
        showTeacherComment: true,
      },
      pausedAt: null,
      totalPoints: items.length,
    },
    items,
  };
}

const load = (v: AttemptView): PlayerState =>
  playerReducer(emptyPlayerState, { type: "load", view: v });

describe("playerReducer: loading", () => {
  it("restores the answers and the position the server remembered (F-LIVE-06)", () => {
    const state = load(
      view(
        "free",
        [item(1, { answer: { selected: [2] }, revision: 4 }), item(2), item(3)],
        "i2",
      ),
    );
    expect(state.index).toBe(1);
    expect(currentItem(state)?.id).toBe("i2");
    expect(state.answers.i1).toEqual({ selected: [2] });
    expect(state.answers.i2).toBeUndefined();
  });

  it("falls back to the first question when the remembered item is gone", () => {
    const state = load(view("free", [item(1), item(2)], "i9"));
    expect(state.index).toBe(0);
  });
});

describe("playerReducer: free navigation", () => {
  const state = load(view("free", [item(1), item(2, { markedDone: true }), item(3)]));

  it("locks nothing, not even a question marked done", () => {
    expect(lockedIds(state).size).toBe(0);
    expect(isLocked(state, "i2")).toBe(false);
  });

  it("reaches any question, in both directions", () => {
    const onThird = playerReducer(state, { type: "goto", itemId: "i3" });
    expect(onThird.index).toBe(2);
    expect(playerReducer(onThird, { type: "move", delta: -1 }).index).toBe(1);
  });

  it("stops at the ends instead of wrapping", () => {
    expect(neighbour(state, -1)).toBeNull();
    const last = playerReducer(state, { type: "goto", itemId: "i3" });
    expect(neighbour(last, 1)).toBeNull();
  });

  it("stays on the question after marking it done, since it is still open", () => {
    const done = playerReducer(state, { type: "done", itemId: "i1", done: true });
    expect(done.index).toBe(0);
    expect(done.items[0]!.markedDone).toBe(true);
  });
});

describe("playerReducer: forward_only", () => {
  const state = load(view("forward_only", [item(1), item(2), item(3)]));

  it("locks a question the moment it is marked done, and moves on (F-LIVE-08)", () => {
    const done = playerReducer(state, { type: "done", itemId: "i1", done: true });
    expect(done.index).toBe(1);
    expect(isLocked(done, "i1")).toBe(true);
    expect(canReach(done, 0)).toBe(false);
  });

  it("refuses to go back to a locked question", () => {
    const done = playerReducer(state, { type: "done", itemId: "i1", done: true });
    expect(playerReducer(done, { type: "goto", itemId: "i1" })).toBe(done);
    expect(playerReducer(done, { type: "move", delta: -1 })).toBe(done);
  });

  it("refuses to write to a locked question", () => {
    const done = playerReducer(state, { type: "done", itemId: "i1", done: true });
    const written = playerReducer(done, { type: "answer", itemId: "i1", payload: { x: 1 } });
    expect(written.answers.i1).toBeUndefined();
    // Adopting the SERVER's payload is not a write and is always allowed.
    const adopted = playerReducer(done, { type: "adopt", itemId: "i1", payload: { x: 2 } });
    expect(adopted.answers.i1).toEqual({ x: 2 });
  });
});

describe("playerReducer: milestones", () => {
  const items = [item(1), item(2, { milestone: true }), item(3), item(4, { milestone: true })];
  const state = load(view("milestones", items));

  it("locks everything up to and including a validated milestone", () => {
    const passed = playerReducer(state, { type: "done", itemId: "i2", done: true });
    expect([...lockedIds(passed)].sort()).toEqual(["i1", "i2"]);
    expect(isLocked(passed, "i3")).toBe(false);
  });

  it("locks nothing when a non-milestone question is marked done", () => {
    const done = playerReducer(state, { type: "done", itemId: "i1", done: true });
    expect(lockedIds(done).size).toBe(0);
  });

  it("skips the locked questions when moving backwards", () => {
    const passed = playerReducer(
      playerReducer(state, { type: "done", itemId: "i2", done: true }),
      { type: "goto", itemId: "i4" },
    );
    expect(passed.index).toBe(3);
    expect(neighbour(passed, -1)).toBe(2);
    const back = playerReducer(passed, { type: "move", delta: -1 });
    expect(back.index).toBe(2);
    expect(neighbour(back, -1)).toBeNull();
  });
});

describe("playerReducer: the server has the last word", () => {
  it("honours items[].locked even when the local rule sees nothing", () => {
    const state = load(view("free", [item(1, { locked: true }), item(2)]));
    expect(isLocked(state, "i1")).toBe(true);
    expect(canReach(state, 0)).toBe(true); // it is where the student already is
    const elsewhere = playerReducer(state, { type: "goto", itemId: "i2" });
    expect(canReach(elsewhere, 0)).toBe(false);
  });
});

describe("playerReducer: won't answer and the review flag (issue #89)", () => {
  const state = load(view("free", [item(1), item(2, { skipped: true, flagged: true })]));

  it("loads both from the server", () => {
    expect(state.items[1]).toMatchObject({ skipped: true, flagged: true });
    expect(state.items[0]).toMatchObject({ skipped: false, flagged: false });
  });

  it("sets and takes back a skip, and toggles a flag", () => {
    const skipped = playerReducer(state, { type: "skip", itemId: "i1", skipped: true });
    expect(skipped.items[0]!.skipped).toBe(true);
    const flagged = playerReducer(skipped, { type: "flag", itemId: "i1", flagged: true });
    expect(flagged.items[0]).toMatchObject({ skipped: true, flagged: true });
    expect(playerReducer(flagged, { type: "flag", itemId: "i1", flagged: false }).items[0]!.flagged).toBe(false);
  });

  it("clears the skip when an answer that holds something is written, not otherwise", () => {
    const empty = playerReducer(state, { type: "answer", itemId: "i2", payload: { selected: [] }, answered: false });
    expect(empty.items[1]!.skipped).toBe(true);
    const written = playerReducer(state, { type: "answer", itemId: "i2", payload: { selected: [1] }, answered: true });
    expect(written.items[1]).toMatchObject({ skipped: false, flagged: true });
  });

  it("returns the same state when nothing moved", () => {
    expect(playerReducer(state, { type: "flag", itemId: "i2", flagged: true })).toBe(state);
  });

  it("refuses both on a validated question in forward_only", () => {
    const fwd = load(view("forward_only", [item(1), item(2)]));
    const done = playerReducer(fwd, { type: "done", itemId: "i1", done: true });
    expect(playerReducer(done, { type: "skip", itemId: "i1", skipped: true })).toBe(done);
    expect(playerReducer(done, { type: "flag", itemId: "i1", flagged: true })).toBe(done);
  });
});
