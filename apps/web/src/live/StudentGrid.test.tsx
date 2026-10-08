import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DashboardRow, DashboardView, EvaluationState } from "@quiz/contracts";

import { initialGrid } from "../realtime/grid";
import { id, LIVE_NOW, liveAt, makeCell, makeDashboard } from "../test/live-fixtures";
import { labelIssues } from "../test/labels";
import { renderWithProviders } from "../test/render";
import { commonDeadline } from "./cells";
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
    onCell: vi.fn(),
    onInspect: vi.fn(),
    onQuestion: vi.fn(),
    onExtend: vi.fn(),
    onClose: vi.fn(),
    onReopen: vi.fn(),
  };
  const rendered = renderWithProviders(
    <StudentGrid
      state={initialGrid(view)}
      clock={() => NOW}
      commonDeadline={commonDeadline(view.evaluation.closesAt, view.rows)}
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
    // Student, Progress, four questions, Actions: no Score while nobody
    // has points, no Time since the header carries the clock (#227).
    expect(screen.getAllByRole("columnheader").map((c) => c.textContent?.trim())).toEqual([
      "Student",
      "Progress",
      "Q1",
      "Q2",
      "Q3",
      "Q4",
      "Actions",
    ]);
  });

  // #227: one line tall; the type is still there, on hover.
  it("keeps the question type in the column header's tooltip", () => {
    setup(viewIn("running", 1, 2));
    const [q1, q2] = screen.getAllByRole("columnheader").slice(2, 4);
    expect(q1).toHaveAttribute("title", "mcq");
    expect(q2).toHaveAttribute("title", "short");
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
    expect(screen.getByRole("columnheader", { name: "Score" })).toBeInTheDocument();
    expect(within(rowOf("Nadia Roux 0")).getByText("3 / 4")).toBeVisible();
    expect(within(rowOf("Nadia Roux 1")).getAllByText("—").length).toBeGreaterThan(0);
  });

  // #227: the column follows the data, header, cells and footer alike.
  it("has no Score column at all while no row has points", () => {
    setup(viewIn("running", 2, 2));
    expect(screen.queryByRole("columnheader", { name: "Score" })).toBeNull();
    // Student, Progress, two questions, Actions — in every row, footer included.
    for (const row of screen.getAllByRole("row")) {
      expect(row.children).toHaveLength(5);
    }
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
    // The percentage alone; the fraction is the tooltip.
    expect(within(rowOf("Nadia Roux 0")).getByText("50 %")).toBeVisible();
    expect(within(rowOf("Nadia Roux 0")).getByTitle("2 of 4 questions answered")).toBeInTheDocument();
  });

  it("counts a skipped question as progress (issue #89)", () => {
    const view = viewIn("running", 1, 2);
    const itemIds = view.items.map((i) => i.id);
    view.rows[0] = {
      ...view.rows[0]!,
      cells: [
        makeCell({ itemId: itemIds[0]!, status: "skipped" }),
        makeCell({ itemId: itemIds[1]!, status: "seen" }),
      ],
    };
    setup(view);
    expect(within(rowOf("Nadia Roux 0")).getByText("50 %")).toBeVisible();
    expect(within(rowOf("Nadia Roux 0")).getByRole("button", { name: /Question 1/ })).toBeInTheDocument();
  });

  it("marks a flagged cell and counts the class's flags in the column header (issue #89)", () => {
    const view = viewIn("running", 3, 2);
    const itemIds = view.items.map((i) => i.id);
    const flag = (rowIndex: number) => {
      const row = view.rows[rowIndex]!;
      view.rows[rowIndex] = {
        ...row,
        cells: row.cells.map((c) => (c.itemId === itemIds[0] ? { ...c, status: "in_progress", flagged: true } : c)),
      };
    };
    flag(0);
    flag(1);
    // A teacher's own test walk flags nothing about the paper's clarity.
    view.rows[2] = { ...view.rows[2]!, staff: true };
    flag(2);
    setup(view);

    const headers = screen.getAllByRole("columnheader");
    const q1 = headers.find((h) => h.textContent?.startsWith("Q1"))!;
    // "Q1", the flag and "2" on one line (#227).
    expect(q1).toHaveTextContent(/^Q12/);
    expect(within(q1).getByText("2 students flagged this question for review")).toBeInTheDocument();
    const q2 = headers.find((h) => h.textContent?.startsWith("Q2"))!;
    expect(q2).toHaveTextContent(/^Q2$/);

    expect(
      within(rowOf("Nadia Roux 0")).getByRole("button", { name: /Question 1 · flagged for review/ }),
    ).toBeInTheDocument();
    expect(
      within(rowOf("Nadia Roux 0")).getByRole("button", { name: /Question 2$/ }),
    ).toBeInTheDocument();
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
  });

  it("says nothing about presence for a student who has handed in", () => {
    const view = viewIn("closed", 2, 2);
    view.rows[0] = { ...view.rows[0]!, state: "submitted", online: false };
    view.rows[1] = { ...view.rows[1]!, state: "not_started", attemptId: null };
    setup(view);
    // The "handed in" badge already carries it; "offline" would be about the
    // browser rather than about the exam.
    expect(within(rowOf("Nadia Roux 0")).queryByRole("img", { name: "offline" })).toBeNull();
    expect(within(rowOf("Nadia Roux 1")).getByRole("img", { name: "never connected" })).toBeInTheDocument();
  });

  // #227: presence is a mark beside the name, never a line under it — and
  // the word stays, as the dot's accessible name and tooltip.
  it("marks an offline student beside the name, on the same line", () => {
    const view = viewIn("running", 1, 2);
    view.rows[0] = { ...view.rows[0]!, online: false };
    setup(view);
    const dot = within(rowOf("Nadia Roux 0")).getByRole("img", { name: "offline" });
    expect(dot).toHaveAttribute("title", "offline");
    // The dot, and the WifiOff beside the name.
    expect(within(rowOf("Nadia Roux 0")).getAllByTitle("offline")).toHaveLength(2);
    expect(within(rowOf("Nadia Roux 0")).queryByText("offline")).toBeNull();
  });

  it("says a student on the roster has not signed in yet, rather than leaving them out", () => {
    const view = viewIn("running", 2, 2);
    view.rows[1] = {
      ...view.rows[1]!,
      userId: null,
      attemptId: null,
      state: "not_started",
      online: false,
    };
    setup(view);
    expect(
      within(rowOf("Nadia Roux 1")).getByRole("img", { name: "has not signed in to Quiz yet" }),
    ).toBeInTheDocument();
    expect(within(rowOf("Nadia Roux 1")).queryByRole("img", { name: "never connected" })).toBeNull();
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
      "Open the whole paper",
      "+5 minutes for this student",
      "Close this attempt",
    ]);
  });

  it("keeps the same three while the quiz is only paused", () => {
    setup(viewIn("paused", 1, 2));
    expect(actionsOf("Nadia Roux 0")).toEqual([
      "Open the whole paper",
      "+5 minutes for this student",
      "Close this attempt",
    ]);
  });

  it("offers nothing but the answers on a finished attempt once the evaluation is closed", () => {
    const view = viewIn("closed", 1, 2);
    view.rows[0] = { ...view.rows[0]!, state: "submitted" };
    setup(view);
    // Reopening there would hand back a paper the server refuses every write
    // to (#95); a make-up session is another feature.
    expect(actionsOf("Nadia Roux 0")).toEqual(["Open the whole paper"]);
  });

  it("keeps close, and only close, on an attempt still open in a finished evaluation", () => {
    // A row reopened after the close, before #95: it must stay closable.
    for (const state of ["closed", "released"] as const) {
      const view = viewIn(state, 1, 2);
      view.rows[0] = { ...view.rows[0]!, state: "in_progress" };
      const { unmount } = setup(view);
      expect(actionsOf("Nadia Roux 0")).toEqual(["Open the whole paper", "Close this attempt"]);
      unmount();
    }
  });

  // F-EVAL-15 (ADR-025): the student starts a new attempt instead; ADR-050:
  // nor once the correction is published. The server says which (`reopenable`).
  it("offers no reopen when the server refuses it, and counts the attempts", () => {
    const view = viewIn("running", 2, 2);
    view.evaluation.reopenable = false;
    view.rows[0] = { ...view.rows[0]!, state: "submitted", attemptCount: 3 };
    setup(view);
    expect(actionsOf("Nadia Roux 0")).toEqual(["Open the whole paper"]);
    expect(within(rowOf("Nadia Roux 0")).getByText("attempt 3")).toBeInTheDocument();
    // One attempt: no badge.
    expect(within(rowOf("Nadia Roux 1")).queryByText(/attempt \d/)).toBeNull();
  });

  it("offers reopen on a finished attempt only while the evaluation runs or is paused", () => {
    for (const state of ["running", "paused"] as const) {
      const view = viewIn(state, 1, 2);
      view.rows[0] = { ...view.rows[0]!, state: "expired" };
      const { unmount } = setup(view);
      expect(actionsOf("Nadia Roux 0")).toEqual(["Open the whole paper", "Reopen this attempt"]);
      unmount();
    }

    const released = viewIn("released", 1, 2);
    released.rows[0] = { ...released.rows[0]!, state: "submitted" };
    setup(released);
    // Giving the paper back would contradict a grade already published.
    expect(actionsOf("Nadia Roux 0")).toEqual(["Open the whole paper"]);
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
    const view = viewIn("running", 2, 2);
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
      within(rowOf("Nadia Roux 1")).getByRole("button", { name: "Open the whole paper" }),
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
      within(rowOf("Nadia Roux 1")).getByRole("button", { name: "Open the whole paper" }),
    );
    expect(onInspect.mock.calls[0]![1]).toBe(view.items[2]!.id);
  });

  it("opens the one answer of the cell that was clicked, not the paper (#353)", async () => {
    const view = viewIn("running", 2, 3);
    const { onCell, onInspect } = setup(view);
    await userEvent.click(screen.getByRole("button", { name: "Nadia Roux 1 · Question 3" }));
    expect(onCell.mock.calls[0]![0]).toMatchObject({ attemptId: id("attempt", 1) });
    expect(onCell.mock.calls[0]![1]).toBe(view.items[2]!.id);
    expect(onInspect).not.toHaveBeenCalled();
  });

  it("opens a question for the whole class from its column header (#353)", async () => {
    const view = viewIn("running", 2, 3);
    const { onQuestion, onCell } = setup(view);
    await userEvent.click(screen.getByRole("button", { name: "Open question 2 for every student" }));
    expect(onQuestion).toHaveBeenCalledWith(view.items[1]!.id);
    expect(onCell).not.toHaveBeenCalled();
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

  /*
   * The actual width is `StudentGrid`'s own `ACTIONS` constant and is none of
   * this test's business — what matters is that a row losing a button does
   * not make the grid jump. So the two cells are compared to EACH OTHER
   * rather than to a frozen `w-26`: retuning the column keeps this green,
   * letting it collapse to its content does not.
   */
  it("holds the actions column at one width whatever a row shows", () => {
    const view = viewIn("running", 2, 2);
    // One row keeps all three buttons, the other has none at all.
    view.rows[1] = { ...view.rows[1]!, attemptId: null, state: "not_started" };
    setup(view);
    const [full, empty] = [rowOf("Nadia Roux 0"), rowOf("Nadia Roux 1")].map((tr) => {
      const cells = tr.querySelectorAll("td");
      return cells[cells.length - 1]!.className;
    });
    expect(full).toBe(empty);
    // And it is a fixed width, not "whatever fits".
    expect(full).toMatch(/\bmin-w-\S+/);
  });
});

describe("StudentGrid — the class row", () => {
  // The head count is the status line's ("19/24 connected"), not the grid's:
  // one number, said once.
  it("reads the completion as a percentage, and does not count the class again", () => {
    const view = viewIn("running", 3, 2);
    view.totals[0] = { ...view.totals[0]!, completion: 0.5 };
    setup(view);
    expect(screen.getByText("50 %")).toBeVisible();
    expect(screen.queryByText(/\b3 students\b/)).toBeNull();
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
  // The fixture's common close is 20 minutes away; these rows have their own.
  it("counts a running attempt with its own deadline down, and shows nothing for one that is over", () => {
    const view = viewIn("running", 2, 2);
    view.rows[0] = { ...view.rows[0]!, state: "in_progress", deadlineAt: liveAt(5 * 60_000) };
    view.rows[1] = { ...view.rows[1]!, state: "submitted", deadlineAt: liveAt(5 * 60_000) };
    setup(view);
    expect(within(rowOf("Nadia Roux 0")).getByText("5:00")).toBeVisible();
    expect(within(rowOf("Nadia Roux 1")).queryByText("5:00")).toBeNull();
  });

  /*
   * #227, F-DASH-03: the header carries the common clock, so a row repeats a
   * countdown only when its deadline is not that one. Compared as instants:
   * the same moment written with and without milliseconds is not "different".
   */
  it("shows no countdown on a row whose deadline is the common one", () => {
    const view = viewIn("running", 1, 2);
    const close = new Date(Math.floor(Date.parse(view.evaluation.closesAt!) / 1000) * 1000);
    view.evaluation.closesAt = close.toISOString(); // "…:00.000Z"
    view.rows[0] = { ...view.rows[0]!, deadlineAt: close.toISOString().replace(".000Z", "Z") };
    setup(view);
    expect(within(rowOf("Nadia Roux 0")).queryByRole("timer")).toBeNull();
  });

  // `duration` timing, started by the teacher: no common close, but the rows
  // share one deadline, which is the header's clock and not the rows'.
  it("shows no countdown on rows that share the deadline of a started quiz", () => {
    const view = viewIn("running", 2, 2);
    view.evaluation.closesAt = null;
    view.rows[0] = { ...view.rows[0]!, state: "in_progress", deadlineAt: liveAt(7 * 60_000) };
    view.rows[1] = { ...view.rows[1]!, state: "in_progress", deadlineAt: liveAt(7 * 60_000) };
    setup(view);
    expect(screen.queryByRole("timer")).toBeNull();
  });

  it("shows every running row's countdown when there is no common close", () => {
    const view = viewIn("running", 1, 2);
    view.evaluation.closesAt = null;
    view.rows[0] = { ...view.rows[0]!, deadlineAt: liveAt(7 * 60_000) };
    setup(view);
    expect(within(rowOf("Nadia Roux 0")).getByText("7:00")).toBeVisible();
  });
});

describe("StudentGrid — how each student sits (ADR-051 §8)", () => {
  it("badges SEB and the station, and says a suspended or unattested station", () => {
    const view = viewIn("running", 4, 2);
    view.rows[1] = { ...view.rows[1]!, access: { kind: "seb", station: null, alert: null } };
    view.rows[2] = { ...view.rows[2]!, access: { kind: "kiosk", station: "Poste n° 7", alert: "suspended" } };
    view.rows[3] = { ...view.rows[3]!, access: { kind: "kiosk", station: "Poste n° 8", alert: "unavailable" } };
    setup(view);
    const portal = rowOf(view.rows[0]!.displayName);
    expect(within(portal).queryByText("SEB")).toBeNull();
    expect(within(portal).queryByText(/Poste/)).toBeNull();
    expect(within(rowOf(view.rows[1]!.displayName)).getByText("SEB")).toBeInTheDocument();
    const suspended = rowOf(view.rows[2]!.displayName);
    expect(within(suspended).getByText("Poste n° 7")).toBeInTheDocument();
    expect(within(suspended).getByText("suspended")).toBeInTheDocument();
    const unavailable = rowOf(view.rows[3]!.displayName);
    expect(within(unavailable).getByText("Poste n° 8")).toBeInTheDocument();
    expect(within(unavailable).getByText("not attested")).toBeInTheDocument();
  });

  it("offers Assign a station on the running rows only when the exam accepts the kiosk", async () => {
    const view = viewIn("running", 2, 2);
    view.rows[1] = { ...view.rows[1]!, state: "submitted" };
    const { unmount } = setup(view);
    expect(screen.queryByRole("button", { name: "Assign a station" })).toBeNull();
    unmount();

    const onAssign = vi.fn();
    setup(view, { onAssign });
    const buttons = screen.getAllByRole("button", { name: "Assign a station" });
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0]!);
    expect(onAssign).toHaveBeenCalledWith(view.rows[0], view.rows[0]!.displayName);
  });
});
