import { describe, expect, it } from "vitest";

import { initialGrid, presence, applyGridEvent } from "../realtime/grid";
import { EVALUATION_ID, id, makeCell, makeDashboard, makeRow } from "../test/live-fixtures";
import { cellState, commonDeadline, ownDeadline } from "./cells";

/*
 * The two things the live dashboard says about a cell and about the room.
 *
 * `cellState` is where the "Results" switch turns a progress colour into a
 * verdict colour. Since ADR-020 the server fills `verdict` from the answer
 * itself while the quiz runs, so the switch has to colour a cell that is
 * merely `in_progress` — green, amber or red — and not wait for the closing.
 *
 * `presence` is the "n of m" of the header and of the lobby ring. A staff row
 * that is online counts in BOTH halves of it: a teacher walking their own
 * quiz is a body in the room (ADR-018 and its presence addendum).
 */

const ITEM = id("item", 0);

describe("cellState — the Results switch", () => {
  it("colours a live verdict on an answer that is only in progress", () => {
    const cell = makeCell({ itemId: ITEM, status: "in_progress", verdict: "correct", provisional: true });
    expect(cellState(cell, true)).toBe("correct");
    // Switch off: the progress colour, exactly as before.
    expect(cellState(cell, false)).toBe("answered");
  });

  it.each([
    ["correct", true],
    ["partial", true],
    ["wrong", true],
    ["correct", false],
    ["wrong", false],
  ] as const)("has a colour for the verdict %s (provisional: %s)", (verdict, provisional) => {
    const cell = makeCell({ itemId: ITEM, status: "done", verdict, provisional });
    expect(cellState(cell, true)).toBe(verdict);
  });

  it.each([
    ["empty", "blank"],
    ["done", "done"],
  ] as const)("leaves a %s cell with no verdict on its progress state", (status, shown) => {
    expect(cellState(makeCell({ itemId: ITEM, status }), true)).toBe(shown);
  });
});

describe("dashboard.cell carries the live verdict forward", () => {
  const state = () =>
    initialGrid(
      makeDashboard(1, 1),
    );

  const event = (verdict: "correct" | "wrong" | null, revision = 2) =>
    ({
      type: "dashboard.cell",
      flagged: false,
      evaluationId: EVALUATION_ID,
      attemptId: id("attempt", 0),
      itemId: id("item", 0),
      status: "in_progress",
      revision,
      points: null,
      summary: "4",
      verdict,
    }) as const;

  it("writes the verdict of the frame and flags it provisional", () => {
    const next = applyGridEvent(state(), event("correct"));
    expect(next.view.rows[0]!.cells[0]).toMatchObject({
      verdict: "correct",
      provisional: true,
    });
  });

  it("drops a provisional verdict the new answer invalidated", () => {
    const green = applyGridEvent(state(), event("correct"));
    const cleared = applyGridEvent(green, event(null, 3));
    expect(cleared.view.rows[0]!.cells[0]!.verdict).toBe(null);
  });

  it("never overwrites a grading on record with a preview", () => {
    const graded = initialGrid({
      ...makeDashboard(1, 1),
      rows: [
        makeRow(0, [id("item", 0)], {
          cells: [
            makeCell({ itemId: id("item", 0), status: "done", verdict: "wrong", provisional: false }),
          ],
        }),
      ],
    });
    const next = applyGridEvent(graded, event("correct"));
    expect(next.view.rows[0]!.cells[0]).toMatchObject({ verdict: "wrong", provisional: false });
  });
});

describe("presence — n of m", () => {
  const itemIds = [id("item", 0)];

  it("counts a staff row that is online, in the numerator and the denominator", () => {
    const view = makeDashboard(1, 1);
    const state = initialGrid({
      ...view,
      rows: [
        makeRow(0, itemIds, { online: false }),
        makeRow(1, itemIds, { staff: true, online: true, displayName: "Yves Chevallier" }),
      ],
    });
    expect(presence(state)).toEqual({ present: 1, enrolled: 2 });
  });

  it("prefers the server's enrolled count, which holds the unclaimed seats", () => {
    const state = applyGridEvent(initialGrid(makeDashboard(2, 1)), {
      type: "lobby.count",
      evaluationId: EVALUATION_ID,
      present: 2,
      enrolled: 24,
    });
    expect(presence(state)).toEqual({ present: 2, enrolled: 24 });
  });
});

/*
 * F-DASH-03 as revised by #227: the header carries the common clock, and a
 * row shows its own only when its deadline is a different INSTANT.
 */
describe("ownDeadline", () => {
  const close = "2026-09-28T10:00:00.000Z";

  it.each([
    // The common deadline, however it is written.
    ["is false for the common deadline", close, close, false],
    ["is false for the common deadline without milliseconds", "2026-09-28T10:00:00Z", close, false],
    ["is false for the common deadline in another offset", "2026-09-28T12:00:00+02:00", close, false],
    // An extension, a bonus or a late start.
    ["is true for a later deadline", "2026-09-28T10:05:00.000Z", close, true],
    ["is true for an earlier deadline", "2026-09-28T09:59:59.000Z", close, true],
    ["is true for any deadline without a common close", "2026-09-28T10:05:00.000Z", null, true],
    ["is false for no deadline at all", null, close, false],
    ["is false for no deadline and no common close", null, null, false],
  ])("%s", (_, own, common, shown) => {
    expect(ownDeadline(own, common)).toBe(shown);
  });
});

/*
 * The header's one clock. In `duration` timing there is no common close, but
 * a quiz the teacher started begins every waiting attempt at one instant, so
 * the running rows share a deadline: that one is the class's clock.
 */
describe("commonDeadline", () => {
  const at = "2026-09-28T10:00:00.000Z";
  const running = (deadlineAt: string | null, n: number) =>
    makeRow(n, [ITEM], { state: "in_progress", deadlineAt });

  it("is the common close whenever there is one", () => {
    expect(commonDeadline(at, [running("2026-09-28T10:05:00.000Z", 0)])).toBe(at);
  });

  it("ignores a leftover close in duration timing, which +N min never moves (#574)", () => {
    const rows = [running("2026-09-28T10:05:00.000Z", 0), running("2026-09-28T10:05:00.000Z", 1)];
    expect(commonDeadline(at, rows, "duration")).toBe("2026-09-28T10:05:00.000Z");
    expect(commonDeadline(at, rows, "deadline")).toBe(at);
  });

  it("is the deadline most running rows share, compared as instants", () => {
    const rows = [
      running(at, 0),
      running("2026-09-28T12:00:00+02:00", 1),
      running("2026-09-28T10:05:00.000Z", 2),
    ];
    expect(Date.parse(commonDeadline(null, rows)!)).toBe(Date.parse(at));
  });

  it("ignores the rows that are no longer running", () => {
    const over = (n: number) => makeRow(n, [ITEM], { state: "submitted", deadlineAt: at });
    const rows = [over(8), over(9), running("2026-09-28T10:05:00.000Z", 0)];
    expect(commonDeadline(null, rows)).toBeNull();
  });

  it("is null when every student started on their own", () => {
    const rows = [running(at, 0), running("2026-09-28T10:00:07.000Z", 1), running(null, 2)];
    expect(commonDeadline(null, rows)).toBeNull();
  });
});
