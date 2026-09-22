import { describe, expect, it } from "vitest";

import { initialGrid, presence, applyGridEvent } from "../realtime/grid";
import { EVALUATION_ID, id, makeCell, makeDashboard, makeRow } from "../test/live-fixtures";
import { cellState } from "./cells";

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

  it("has a colour for each of the three verdicts, provisional or not", () => {
    const of = (verdict: "correct" | "partial" | "wrong", provisional: boolean) =>
      cellState(makeCell({ itemId: ITEM, status: "done", verdict, provisional }), true);
    expect(of("correct", true)).toBe("correct");
    expect(of("partial", true)).toBe("partial");
    expect(of("wrong", true)).toBe("wrong");
    expect(of("correct", false)).toBe("correct");
    expect(of("wrong", false)).toBe("wrong");
  });

  it("leaves a cell with no verdict on its progress state", () => {
    const empty = makeCell({ itemId: ITEM, status: "empty" });
    expect(cellState(empty, true)).toBe("blank");
    expect(cellState(makeCell({ itemId: ITEM, status: "done" }), true)).toBe("done");
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
