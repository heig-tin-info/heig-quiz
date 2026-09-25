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
    flagged: false,
    evaluationId: EVALUATION_ID,
    attemptId: id("attempt", 0),
    itemId: ITEM(0),
    status: "done",
    revision: 4,
    points: null,
    summary: "B",
    verdict: null,
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

  it("rounds the completion with round2, as the server does: 23 of 40 is 0.58", () => {
    const view = makeDashboard(40, 1);
    // Rows 1..22 are done; the event makes row 0 the 23rd. In binary
    // 23/40*100 is 57.49999…, which Math.round turned into 0.57.
    for (const row of view.rows.slice(1, 23)) row.cells[0] = { ...row.cells[0]!, status: "done" };
    const after = applyGridEvent(initialGrid(view), cellEvent());
    expect(after.view.totals[0]!.completion).toBe(0.58);
  });

  it("lands a flag on its own: same revision, only the flag moved (issue #89)", () => {
    const first = applyGridEvent(state(), cellEvent());
    const flagged = applyGridEvent(first, cellEvent({ flagged: true }));
    expect(flagged).not.toBe(first);
    expect(flagged.view.rows[0]!.cells[0]!.flagged).toBe(true);
    const unflagged = applyGridEvent(flagged, cellEvent({ flagged: false }));
    expect(unflagged.view.rows[0]!.cells[0]!.flagged).toBe(false);
  });

  it("counts an answered, a skipped and a validated question toward completion, never a seen one", () => {
    const before = state();
    for (const [status, completion] of [
      ["in_progress", 0.33],
      ["skipped", 0.33],
      ["done", 0.33],
      ["seen", 0],
    ] as const) {
      expect(applyGridEvent(before, cellEvent({ status })).view.totals[0]!.completion).toBe(completion);
    }
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

/*
 * The frame that did not exist: a roster row without an attempt showed
 * "never connected" for the whole evaluation, because `attempt.deadline`
 * rides the attempt topic and the teacher watches the evaluation one.
 */
describe("applyGridEvent — dashboard.attempt", () => {
  /** A dashboard where row 1 is on the roster but has not entered yet. */
  const waiting = () => {
    const view = makeDashboard(3, 4);
    const rows = view.rows.slice();
    rows[1] = { ...rows[1]!, attemptId: null, state: "not_started", deadlineAt: null };
    return initialGrid({ ...view, rows });
  };

  const event = (over: Record<string, unknown> = {}) =>
    ({
      type: "dashboard.attempt",
      evaluationId: EVALUATION_ID,
      userId: id("user", 1),
      attemptId: id("attempt", 1),
      state: "in_progress",
      startedAt: liveAt(0),
      deadlineAt: liveAt(30 * 60_000),
      ...over,
    }) as ServerEvent;

  it("gives the row its attempt, its state and its deadline", () => {
    const next = applyGridEvent(waiting(), event());
    const row = next.view.rows[1]!;
    expect(row.attemptId).toBe(id("attempt", 1));
    expect(row.state).toBe("in_progress");
    expect(row.deadlineAt).toBe(liveAt(30 * 60_000));
  });

  it("records the attempt created in the lobby, before the start", () => {
    const next = applyGridEvent(
      waiting(),
      event({ state: "not_started", startedAt: null, deadlineAt: null }),
    );
    expect(next.view.rows[1]!.attemptId).toBe(id("attempt", 1));
    expect(next.view.rows[1]!.state).toBe("not_started");
  });

  it("lets the first dashboard.cell of that student land, now that the row is keyed", () => {
    const started = applyGridEvent(waiting(), event());
    const answered = applyGridEvent(started, {
      type: "dashboard.cell",
      flagged: false,
      evaluationId: EVALUATION_ID,
      attemptId: id("attempt", 1),
      itemId: ITEM(0),
      status: "done",
      revision: 1,
      points: null,
      summary: "42",
      verdict: null,
    });
    expect(answered.view.rows[1]!.cells[0]!.status).toBe("done");
  });

  it("moves the denominator of every completion: one more started row", () => {
    // Two started rows, one of them done on Q1 — 50 %.
    const before = applyGridEvent(waiting(), {
      type: "dashboard.cell",
      flagged: false,
      evaluationId: EVALUATION_ID,
      attemptId: id("attempt", 0),
      itemId: ITEM(0),
      status: "done",
      revision: 1,
      points: null,
      summary: null,
      verdict: null,
    });
    expect(before.view.totals[0]!.completion).toBe(0.5);
    // A third row enters: the same one done is now a third of them.
    const after = applyGridEvent(before, event());
    expect(after.view.totals[0]!.completion).toBe(0.33);
  });

  it("leaves the other rows untouched, by identity, and repeats as a no-op", () => {
    const before = waiting();
    const after = applyGridEvent(before, event());
    expect(after.view.rows[0]).toBe(before.view.rows[0]);
    expect(applyGridEvent(after, event())).toBe(after);
  });

  it("ignores another evaluation and a user who is not on the roster", () => {
    const before = waiting();
    expect(applyGridEvent(before, event({ evaluationId: id("evaluation", 9) }))).toBe(before);
    expect(applyGridEvent(before, event({ userId: id("user", 99) }))).toBe(before);
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
  const counted = (present: number, enrolled: number) =>
    ({ type: "lobby.count", evaluationId: EVALUATION_ID, present, enrolled }) as ServerEvent;

  it("takes the enrolment from the event: it counts unclaimed roster lines too", () => {
    const next = applyGridEvent(state(), counted(18, 24));
    expect(presence(next).enrolled).toBe(24);
  });

  it("counts the rows until one arrives", () => {
    expect(presence(state())).toEqual({ present: 3, enrolled: 3 });
  });

  /*
   * The header used to read "0 of 6 connected" under a green name. The room
   * figure only moves when a stream opens or closes; the dots move on every
   * `dashboard.presence`. Two channels, one sentence — so `present` is now
   * counted from the rows, which is what the dots are drawn from.
   */
  it("never lets the room figure contradict the dots on the same screen", () => {
    const stale = applyGridEvent(state(), counted(0, 3));
    expect(presence(stale).present).toBe(3);

    const oneLeft = applyGridEvent(stale, {
      type: "dashboard.presence",
      evaluationId: EVALUATION_ID,
      userId: id("user", 1),
      online: false,
      lastSeenAt: liveAt(-5_000),
    });
    expect(presence(oneLeft).present).toBe(2);
    expect(oneLeft.view.rows.filter((r) => r.online)).toHaveLength(2);
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
