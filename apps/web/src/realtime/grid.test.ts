import { describe, expect, it } from "vitest";

import type { ServerEvent } from "@quiz/contracts";

import {
  EVALUATION_ID,
  id,
  liveAt,
  makeDashboard,
} from "../test/live-fixtures";
import { applyGridEvent, initialGrid, presence } from "./grid";

/*
 * The reducer is the piece where a wrong answer means a teacher reading a
 * wrong grid, so it is tested without a DOM, a query client or a socket.
 *
 * Two properties matter as much as the values: an event that changes nothing
 * returns the SAME object (React re-renders nothing at 30 x 12), and a late
 * `dashboard.cell` never overwrites a newer one.
 */

const ITEM = (n: number) => id("item", n);
const state = () => initialGrid(makeDashboard(3, 4));

function cellEvent(over: Partial<Extract<ServerEvent, { type: "dashboard.cell" }>> = {}) {
  return {
    type: "dashboard.cell",
    evaluationId: EVALUATION_ID,
    attemptId: id("attempt", 0),
    itemId: ITEM(0),
    status: "done",
    revision: 4,
    points: null,
    summary: "B",
    ...over,
  } satisfies ServerEvent;
}

describe("applyGridEvent — dashboard.cell", () => {
  it("writes the status, the revision and the answer of one cell", () => {
    const next = applyGridEvent(state(), cellEvent());
    const cell = next.view.rows[0]!.cells[0]!;
    expect(cell.status).toBe("done");
    expect(cell.revision).toBe(4);
    expect(cell.summary).toBe("B");
  });

  it("leaves every other row and cell untouched, by identity", () => {
    const before = state();
    const after = applyGridEvent(before, cellEvent());
    expect(after.view.rows[1]).toBe(before.view.rows[1]);
    expect(after.view.rows[0]!.cells[1]).toBe(before.view.rows[0]!.cells[1]);
    expect(after.view.items).toBe(before.view.items);
  });

  it("ignores an out-of-order revision", () => {
    const fresh = applyGridEvent(state(), cellEvent({ revision: 7, summary: "C" }));
    const late = applyGridEvent(fresh, cellEvent({ revision: 3, summary: "A", status: "seen" }));
    // Same object: nothing was written, so nothing re-renders either.
    expect(late).toBe(fresh);
    expect(late.view.rows[0]!.cells[0]!.summary).toBe("C");
  });

  it("returns the same state for an event that changes nothing", () => {
    const first = applyGridEvent(state(), cellEvent());
    expect(applyGridEvent(first, cellEvent())).toBe(first);
  });

  it("recomputes the completion of the item it touched, and only that one", () => {
    const before = state();
    const after = applyGridEvent(before, cellEvent());
    // One of three started rows is done on Q1, rounded the way the server
    // rounds it (two decimals).
    expect(after.view.totals[0]!.completion).toBe(0.33);
    expect(after.view.totals[1]).toBe(before.view.totals[1]);
  });

  it("ignores an event addressed to another evaluation or to an unknown attempt", () => {
    const before = state();
    expect(applyGridEvent(before, cellEvent({ evaluationId: id("evaluation", 9) }))).toBe(before);
    expect(applyGridEvent(before, cellEvent({ attemptId: id("attempt", 99) }))).toBe(before);
    expect(applyGridEvent(before, cellEvent({ itemId: id("item", 99) }))).toBe(before);
  });
});

describe("applyGridEvent — dashboard.presence", () => {
  const event = (over: Record<string, unknown> = {}) =>
    ({
      type: "dashboard.presence",
      evaluationId: EVALUATION_ID,
      userId: id("user", 1),
      online: false,
      lastSeenAt: liveAt(-5_000),
      ...over,
    }) as ServerEvent;

  it("flips one student offline", () => {
    const next = applyGridEvent(state(), event());
    expect(next.view.rows[1]!.online).toBe(false);
    expect(next.view.rows[0]!.online).toBe(true);
  });

  it("is a no-op when the row already says so", () => {
    const first = applyGridEvent(state(), event());
    expect(applyGridEvent(first, event())).toBe(first);
  });
});

describe("applyGridEvent — evaluation.state", () => {
  it("moves the state, the pause and the common deadline together", () => {
    const next = applyGridEvent(state(), {
      type: "evaluation.state",
      evaluationId: EVALUATION_ID,
      state: "paused",
      pausedAt: liveAt(0),
      closesAt: liveAt(30 * 60_000),
      serverNow: liveAt(0),
    });
    expect(next.view.evaluation.state).toBe("paused");
    expect(next.view.evaluation.pausedAt).not.toBeNull();
  });

  it("leaves the rows alone", () => {
    const before = state();
    const next = applyGridEvent(before, {
      type: "evaluation.state",
      evaluationId: EVALUATION_ID,
      state: "paused",
      pausedAt: liveAt(0),
      closesAt: null,
      serverNow: liveAt(0),
    });
    expect(next.view.rows).toBe(before.view.rows);
  });
});

describe("applyGridEvent — lobby.count", () => {
  it("adopts the authoritative figures", () => {
    const next = applyGridEvent(state(), {
      type: "lobby.count",
      evaluationId: EVALUATION_ID,
      present: 18,
      enrolled: 24,
    });
    expect(presence(next)).toEqual({ present: 18, enrolled: 24 });
  });

  it("falls back to counting the rows until one arrives", () => {
    expect(presence(state())).toEqual({ present: 3, enrolled: 3 });
  });
});

describe("applyGridEvent — attempt events", () => {
  it("a student handing in is `submitted`, anything else is `expired`", () => {
    const byStudent = applyGridEvent(state(), {
      type: "attempt.closed",
      attemptId: id("attempt", 0),
      evaluationId: EVALUATION_ID,
      closedBy: "student",
      serverNow: liveAt(0),
    });
    expect(byStudent.view.rows[0]!.state).toBe("submitted");
    const byTeacher = applyGridEvent(state(), {
      type: "attempt.closed",
      attemptId: id("attempt", 0),
      evaluationId: EVALUATION_ID,
      closedBy: "teacher",
      serverNow: liveAt(0),
    });
    expect(byTeacher.view.rows[0]!.state).toBe("expired");
  });

  it("an extension moves one student's deadline", () => {
    const next = applyGridEvent(state(), {
      type: "attempt.deadline",
      attemptId: id("attempt", 2),
      deadlineAt: liveAt(25 * 60_000),
      bonusS: 300,
      reason: "teacher_extend",
      serverNow: liveAt(0),
    });
    expect(next.view.rows[2]!.deadlineAt).toBe(liveAt(25 * 60_000));
    expect(next.view.rows[1]!.deadlineAt).not.toBe(liveAt(25 * 60_000));
  });
});

describe("applyGridEvent — what the grid does not read", () => {
  it("returns the same state for a clock, a hint or a runner result", () => {
    const before = state();
    for (const event of [
      { type: "clock", serverNow: liveAt(0) },
      { type: "hint", kinds: ["evaluations"], notice: null },
      { type: "grading.progress", evaluationId: EVALUATION_ID, done: 1, total: 2, phase: "auto" },
    ] as ServerEvent[]) {
      expect(applyGridEvent(before, event)).toBe(before);
    }
  });
});
