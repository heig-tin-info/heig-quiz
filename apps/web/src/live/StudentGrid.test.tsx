import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DashboardRow, DashboardView, EvaluationState } from "@quiz/contracts";

import { initialGrid } from "../realtime/grid";
import { id, LIVE_NOW, liveAt, makeCell, makeDashboard } from "../test/live-fixtures";
import { labelIssues } from "../test/labels";
import { renderWithProviders } from "../test/render";
import { StudentGrid } from "./StudentGrid";

/*
 * The grid on its own, with no dashboard, no stream and no fetch around it:
 * `StudentGrid` is a pure function of `(GridState, toggles)` and this file
 * holds it to that. Everything it must keep doing through the refactoring is
 * here — the shape of a row, WHICH row actions exist in which evaluation
 * state (the mirror of the server's rules, so no button is offered that the
 * API would refuse), and the two sticky ends that make a 30 x 12 matrix
 * readable.
 *
 * The sticky columns are asserted through their utility classes. That is a
 * deliberate exception to "query by role": they are the documented reason
 * this screen is allowed to break the seven-column rule of the design
 * system, jsdom runs no layout so there is nothing else to measure, and the
 * audit keeps them under "keep as is".
 */

const NOW = LIVE_NOW.getTime();

/** The dashboard of `makeDashboard`, with the evaluation put in `state`. */
function viewIn(state: EvaluationState, rows = 3, items = 4): DashboardView {
  const view = makeDashboard(rows, items);
  view.evaluation.state = state;
  return view;
}

function setup(view: DashboardView, over: Partial<Parameters<typeof StudentGrid>[0]> = {}) {
  const handlers = {
    onInspect: vi.fn(),
    onExtend: vi.fn(),
    onClose: vi.fn(),
    onReopen: vi.fn(),
  };
  const rendered = renderWithProviders(
    <StudentGrid
      state={initialGrid(view)}
      now={NOW}
      paused={view.evaluation.state === "paused"}
      nameOf={(row) => row.displayName}
      showAnswers
      showResults
      selected={null}
      {...handlers}
      {...over}
    />,
  );
  return { ...rendered, ...handlers };
}

/** The `<tr>` of one student, found by the name the grid printed for them. */
const rowOf = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

describe("StudentGrid — the rows", () => {
  it("draws one row per student plus the header and the class row", () => {
    setup(viewIn("running", 3, 4));
    expect(screen.getByRole("table")).toHaveAccessibleName("Student progress");
    expect(screen.getAllByRole("row")).toHaveLength(5);
    // Student, Score, Time, four questions, Actions.
    expect(screen.getAllByRole("columnheader").map((c) => c.textContent?.trim())).toEqual([
      "Student",
      "Score",
      "Time",
      "Q1mcq",
      "Q2short",
      "Q3mcq",
      "Q4short",
      "Actions",
    ]);
  });

  it("names a row through `nameOf`, not through the payload", () => {
    setup(viewIn("running", 2, 2), { nameOf: (row: DashboardRow) => `Anon ${row.pseudonym}` });
    expect(screen.getByText("Anon Wise Otter")).toBeVisible();
    expect(screen.queryByText("Nadia Roux 0")).toBeNull();
  });

  it("reads the score as a dash until there is one, and as points over the maximum after", () => {
    const view = viewIn("released", 2, 4);
    view.rows[0] = { ...view.rows[0]!, points: 3, maxPoints: 4, state: "submitted" };
    setup(view);
    expect(within(rowOf("Nadia Roux 0")).getByText("3 / 4")).toBeVisible();
    expect(within(rowOf("Nadia Roux 1")).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("carries the progress of the row, counting only what was written in", () => {
    const view = viewIn("running", 1, 4);
    const itemIds = view.items.map((i) => i.id);
    view.rows[0] = {
      ...view.rows[0]!,
      cells: [
        makeCell({ itemId: itemIds[0]!, status: "done" }),
        makeCell({ itemId: itemIds[1]!, status: "in_progress" }),
        // `seen` is not progress: the student opened it and wrote nothing.
        makeCell({ itemId: itemIds[2]!, status: "seen" }),
        makeCell({ itemId: itemIds[3]!, status: "empty" }),
      ],
    };
    setup(view);
    expect(within(rowOf("Nadia Roux 0")).getByText("2/4 · 50 %")).toBeVisible();
  });

  it("badges a student who handed in, and one who ran out of time", () => {
    const view = viewIn("closed", 2, 2);
    view.rows[0] = { ...view.rows[0]!, state: "submitted" };
    view.rows[1] = { ...view.rows[1]!, state: "expired" };
    setup(view);
    expect(within(rowOf("Nadia Roux 0")).getByText("handed in")).toBeVisible();
    expect(within(rowOf("Nadia Roux 1")).getByText("closed")).toBeVisible();
  });

  it("badges the time bonus and the teacher walking their own quiz", () => {
    const view = viewIn("running", 2, 2);
    view.rows[0] = { ...view.rows[0]!, timeBonusPercent: 33 };
    view.rows[1] = { ...view.rows[1]!, staff: true };
    setup(view);
    expect(within(rowOf("Nadia Roux 0")).getByText("+33 % time")).toBeVisible();
    expect(within(rowOf("Nadia Roux 1")).getByText("staff")).toBeVisible();
    // The staff row counts in no total under the grid.
    expect(screen.getByText(/1 students/)).toBeVisible();
  });

  it("says nothing about presence for a student who has handed in", () => {
    const view = viewIn("closed", 2, 2);
    view.rows[0] = { ...view.rows[0]!, state: "submitted", online: false };
    view.rows[1] = { ...view.rows[1]!, state: "not_started", attemptId: null };
    setup(view);
    // The "handed in" badge already carries it; "offline" would be about the
    // browser rather than about the exam.
    expect(within(rowOf("Nadia Roux 0")).queryByText("offline")).toBeNull();
    expect(within(rowOf("Nadia Roux 1")).getAllByText("never connected").length).toBeGreaterThan(0);
  });

  it("gives every cell an accessible name that says whose and which question", () => {
    setup(viewIn("running", 2, 3));
    expect(
      screen.getByRole("button", { name: "Nadia Roux 1 · Question 2" }),
    ).toBeInTheDocument();
  });

  it("offers no clickable cell for a student who never started", () => {
    const view = viewIn("running", 1, 2);
    view.rows[0] = { ...view.rows[0]!, attemptId: null, state: "not_started" };
    setup(view);
    expect(screen.queryByRole("button", { name: /Question 1$/ })).toBeNull();
  });

  it("gives every <label for> of the grid a control to point at", () => {
    setup(viewIn("running", 3, 4));
    expect(labelIssues()).toEqual([]);
  });
});

describe("StudentGrid — the row actions per state", () => {
  const actionsOf = (name: string) =>
    within(rowOf(name))
      // `queryAll`: a row with no attempt offers no button at all, and that
      // is one of the cases below rather than a broken query.
      .queryAllByRole("button")
      .map((b) => b.getAttribute("aria-label"))
      .filter((label): label is string => label !== null && !label.includes("· Question"));

  it("offers inspect, extend and close on a running attempt while the quiz runs", () => {
    setup(viewIn("running", 1, 2));
    expect(actionsOf("Nadia Roux 0")).toEqual([
      "Open the answers",
      "+5 minutes for this student",
      "Close this attempt",
    ]);
  });

  it("keeps the same three while the quiz is only paused", () => {
    setup(viewIn("paused", 1, 2));
    expect(actionsOf("Nadia Roux 0")).toEqual([
      "Open the answers",
      "+5 minutes for this student",
      "Close this attempt",
    ]);
  });

  it("drops extend and close once the evaluation itself is closed", () => {
    const view = viewIn("closed", 1, 2);
    view.rows[0] = { ...view.rows[0]!, state: "submitted" };
    setup(view);
    expect(actionsOf("Nadia Roux 0")).toEqual(["Open the answers", "Reopen this attempt"]);
  });

  it("offers reopen on a finished attempt, and never once the results are out", () => {
    const closed = viewIn("closed", 1, 2);
    closed.rows[0] = { ...closed.rows[0]!, state: "expired" };
    const { unmount } = setup(closed);
    expect(actionsOf("Nadia Roux 0")).toContain("Reopen this attempt");
    unmount();

    const released = viewIn("released", 1, 2);
    released.rows[0] = { ...released.rows[0]!, state: "submitted" };
    setup(released);
    // Giving the paper back would contradict a grade already published.
    expect(actionsOf("Nadia Roux 0")).toEqual(["Open the answers"]);
  });

  it("offers nothing at all on a row with no attempt", () => {
    const view = viewIn("running", 1, 2);
    view.rows[0] = { ...view.rows[0]!, attemptId: null, state: "not_started" };
    setup(view);
    expect(actionsOf("Nadia Roux 0")).toEqual([]);
  });

  it("hands the whole row back to the extend handler", async () => {
    const { onExtend } = setup(viewIn("running", 2, 2));
    await userEvent.click(
      within(rowOf("Nadia Roux 1")).getByRole("button", { name: "+5 minutes for this student" }),
    );
    expect(onExtend).toHaveBeenCalledTimes(1);
    expect(onExtend.mock.calls[0]![0]).toMatchObject({
      attemptId: id("attempt", 1),
      displayName: "Nadia Roux 1",
    });
  });

  it("asks the page to close, and to reopen, the row it was clicked on", async () => {
    const view = viewIn("closed", 2, 2);
    view.rows[0] = { ...view.rows[0]!, state: "submitted" };
    const { onReopen } = setup(view);
    await userEvent.click(
      within(rowOf("Nadia Roux 0")).getByRole("button", { name: "Reopen this attempt" }),
    );
    expect(onReopen).toHaveBeenCalledTimes(1);
    expect(onReopen.mock.calls[0]![0]).toMatchObject({ attemptId: id("attempt", 0) });
  });

  it("inspects the first question when the eye is used rather than a cell", async () => {
    const view = viewIn("running", 2, 3);
    const { onInspect } = setup(view);
    await userEvent.click(
      within(rowOf("Nadia Roux 1")).getByRole("button", { name: "Open the answers" }),
    );
    expect(onInspect).toHaveBeenCalledTimes(1);
    expect(onInspect.mock.calls[0]![1]).toBe(view.items[0]!.id);
  });

  it("keeps the selected question when there is one", async () => {
    const view = viewIn("running", 2, 3);
    const { onInspect } = setup(view, {
      selected: { attemptId: id("attempt", 0), itemId: view.items[2]!.id },
    });
    await userEvent.click(
      within(rowOf("Nadia Roux 1")).getByRole("button", { name: "Open the answers" }),
    );
    expect(onInspect.mock.calls[0]![1]).toBe(view.items[2]!.id);
  });

  it("inspects the cell that was clicked", async () => {
    const view = viewIn("running", 2, 3);
    const { onInspect } = setup(view);
    await userEvent.click(screen.getByRole("button", { name: "Nadia Roux 1 · Question 3" }));
    expect(onInspect.mock.calls[0]![1]).toBe(view.items[2]!.id);
  });
});

describe("StudentGrid — the sticky ends", () => {
  it("pins the identity column at the left, on every viewport", () => {
    setup(viewIn("running", 2, 4));
    const head = screen.getAllByRole("columnheader")[0]!;
    expect(head.className).toContain("sticky");
    expect(head.className).toContain("left-0");
    const cell = within(rowOf("Nadia Roux 0")).getByRole("rowheader");
    expect(cell.className).toContain("sticky");
    expect(cell.className).toContain("left-0");
  });

  /*
   * The actions column pins only from `sm`. That is not a detail: 390 px of
   * phone minus a 176 px identity column leaves 68 px, which is one question
   * — a pair of pinned ends with a slot between them, not a matrix.
   */
  it("pins the actions column at the right from `sm` up, and not below it", () => {
    setup(viewIn("running", 2, 4));
    const head = screen.getAllByRole("columnheader").at(-1)!;
    expect(head.className).toContain("sm:sticky");
    expect(head.className).toContain("sm:right-0");
    expect(head.className).not.toMatch(/(^|\s)sticky(\s|$)/);
  });

  it("holds the actions column at one width whatever a row shows", () => {
    const view = viewIn("running", 2, 2);
    // One row keeps all three buttons, the other has none at all.
    view.rows[1] = { ...view.rows[1]!, attemptId: null, state: "not_started" };
    setup(view);
    const widths = [rowOf("Nadia Roux 0"), rowOf("Nadia Roux 1")].map((tr) => {
      const last = tr.querySelectorAll("td")[tr.querySelectorAll("td").length - 1]!;
      return last.className.includes("w-26 min-w-26");
    });
    expect(widths).toEqual([true, true]);
  });
});

describe("StudentGrid — the class row", () => {
  it("counts the students, the staff excluded, and reads the completion as a percentage", () => {
    const view = viewIn("running", 3, 2);
    view.totals[0] = { ...view.totals[0]!, completion: 0.5 };
    setup(view);
    expect(screen.getByText(/3 students/)).toBeVisible();
    expect(screen.getByText("50 %")).toBeVisible();
  });

  it("says the rate is a live one while the answers are being graded as they land", () => {
    const view = viewIn("running", 3, 2);
    view.totals[0] = { ...view.totals[0]!, successRate: 0.75, provisional: true };
    setup(view);
    expect(screen.getByText("75 % live")).toBeVisible();
  });

  it("says where the missing rate will come from, and the answer depends on the switch", () => {
    const view = viewIn("running", 3, 2);
    const { unmount } = setup(view, { showResults: true });
    expect(screen.getAllByText("graded at closing").length).toBe(2);
    unmount();
    setup(view, { showResults: false });
    expect(screen.getAllByText("after closing").length).toBe(2);
  });
});

describe("StudentGrid — the clock", () => {
  it("counts a running attempt down, and shows nothing for one that is over", () => {
    const view = viewIn("running", 2, 2);
    view.rows[0] = { ...view.rows[0]!, state: "in_progress", deadlineAt: liveAt(5 * 60_000) };
    view.rows[1] = { ...view.rows[1]!, state: "submitted", deadlineAt: liveAt(5 * 60_000) };
    setup(view);
    expect(within(rowOf("Nadia Roux 0")).getByText("5:00")).toBeVisible();
    expect(within(rowOf("Nadia Roux 1")).queryByText("5:00")).toBeNull();
  });
});
