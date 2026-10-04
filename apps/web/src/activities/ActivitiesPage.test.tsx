import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActivitySummary, EvaluationActivitySummary, ProjectActivitySummary } from "@quiz/contracts";

import { id, liveAt } from "../test/live-fixtures";
import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { ActivitiesPage } from "./ActivitiesPage";

/*
 * The Activities section (#190): the three views, the filters, the "Live
 * now" block, and End — for a running poll only, behind a confirmation.
 */

const MIN = 60_000;
const ROOM = { id: id("classroom", 1), name: "PRG1-2026", courseCode: "PRG1" };

function activity(n: number, over: Partial<EvaluationActivitySummary> = {}): EvaluationActivitySummary {
  return {
    kind: "evaluation",
    id: id("activity", n),
    title: `Activity ${n}`,
    mode: "exam",
    state: "draft",
    classroom: ROOM,
    takeHome: false,
    opensAt: null,
    closesAt: null,
    startedAt: null,
    closedAt: null,
    closedBy: null,
    updatedAt: liveAt(-MIN),
    ...over,
  };
}

const EXAM = activity(1, {
  title: "Quiz 3 — pointers",
  state: "running",
  startedAt: liveAt(-25 * MIN),
  closesAt: liveAt(20 * MIN),
});
const POLL = activity(2, { title: "Which loop?", mode: "poll", state: "running", classroom: null, startedAt: liveAt(-4 * MIN) });
const SERIES = activity(3, {
  title: "Série 5 — UART",
  mode: "exercise",
  takeHome: true,
  state: "running",
  opensAt: liveAt(-2 * 24 * 60 * MIN),
  closesAt: liveAt(4 * 24 * 60 * MIN),
  startedAt: liveAt(-2 * 24 * 60 * MIN),
});
const NEXT = activity(4, { title: "Série 6 — SPI", mode: "exercise", takeHome: true, state: "scheduled", opensAt: liveAt(7 * 24 * 60 * MIN) });
const DONE = activity(5, { title: "Test 0", state: "released", startedAt: liveAt(-30 * 24 * 60 * MIN) });
const ALL = [EXAM, POLL, SERIES, NEXT, DONE];
const DRAFT = activity(7, { title: "Quiz 1 — draft" });

beforeEach(() => {
  localStorage.removeItem("quiz-activities-view");
  localStorage.removeItem("quiz-activities-tab");
});

/** A published project in its span, and a draft one (M3-10). */
const LAB: ProjectActivitySummary = {
  kind: "project",
  id: id("project", 1),
  title: "Labo 2 — pointeurs",
  state: "published",
  classroom: ROOM,
  startAt: liveAt(-7 * 24 * 60 * MIN),
  deadlineAt: liveAt(7 * 24 * 60 * MIN),
};
const LAB3: ProjectActivitySummary = { ...LAB, id: id("project", 2), title: "Labo 3", state: "draft" };

const render = (rows: ActivitySummary[] = ALL, navigate = vi.fn()) => {
  const stub = mockFetch({
    "GET /app/api/activities": ok(rows),
    "GET /app/api/activities/stats": ok({ studentsInProgress: 42 }),
  });
  renderWithProviders(<ActivitiesPage navigate={navigate} />);
  return { navigate, ...stub };
};

/** This week's list of the phone schedule (the summary tiles name titles too). */
const thisWeek = () => within(screen.getByRole("heading", { name: /This week/ }).closest("section")!);

const liveBlock = async () =>
  screen.findByRole("region", { name: "Live now" });

describe("ActivitiesPage", () => {
  it("puts the live exam and the running poll in 'Live now', never the take-home series", async () => {
    render();
    const live = await liveBlock();
    expect(within(live).getByText("Quiz 3 — pointers")).toBeInTheDocument();
    expect(within(live).getByText("Which loop?")).toBeInTheDocument();
    expect(within(live).queryByText("Série 5 — UART")).not.toBeInTheDocument();
    // Since when, and until when.
    expect(within(live).getByText(/closes at/)).toBeInTheDocument();
  });

  it("shows no 'Live now' block when nothing is live", async () => {
    render([SERIES, NEXT, DONE]);
    expect(await screen.findByText("Série 6 — SPI")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Live now" })).not.toBeInTheDocument();
  });

  it("ends a poll from the list only after the confirmation, and offers no End for an exam", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /app/api/activities": ok(ALL),
      [`POST /app/api/evaluations/${POLL.id}/poll/end`]: ok({}),
    });
    renderWithProviders(<ActivitiesPage navigate={vi.fn()} />);
    const live = await liveBlock();
    // One End, the poll's: the exam ends on its dashboard.
    expect(within(live).getAllByRole("button", { name: /^End the poll/ })).toHaveLength(1);

    await user.click(within(live).getByRole("button", { name: "End the poll Which loop?" }));
    const dialog = await screen.findByRole("dialog");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "End poll" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/poll/end"))).toBe(true),
    );
  });

  it("opens the dashboard of a live exam and the projection of a poll", async () => {
    const user = userEvent.setup();
    const { navigate } = render();
    const live = await liveBlock();
    await user.click(within(live).getByRole("button", { name: "Live dashboard" }));
    expect(navigate).toHaveBeenLastCalledWith({ view: "live", id: EXAM.id });
    await user.click(within(live).getByRole("button", { name: "Open projection" }));
    expect(navigate).toHaveBeenLastCalledWith({ view: "poll", id: POLL.id });
  });

  it("lists what runs and what is planned in the table, open first, and opens a row where its classroom would", async () => {
    const user = userEvent.setup();
    const { navigate } = render();
    const table = await screen.findByRole("table");
    const titles = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.querySelector(".font-semibold")?.textContent);
    expect(titles.at(-1)).toBe("Série 6 — SPI");
    expect(titles).not.toContain("Test 0");
    expect(titles.indexOf("Série 6 — SPI")).toBeGreaterThan(titles.indexOf("Série 5 — UART"));
    await user.click(within(table).getByText("Série 6 — SPI"));
    expect(navigate).toHaveBeenLastCalledWith({ view: "evaluation", id: NEXT.id });
  });

  it("splits the list in three tabs, opens on what runs and is planned, and remembers the choice", async () => {
    const user = userEvent.setup();
    const { navigate } = render([...ALL, DRAFT]);
    const tabs = await screen.findByRole("tablist", { name: "Activities by state" });
    expect(within(tabs).getByRole("tab", { name: /In progress & upcoming\s*4/, selected: true })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: /Drafts\s*1/ })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: /Ended\s*1/ })).toBeInTheDocument();
    expect(within(screen.getByRole("table")).queryByText("Quiz 1 — draft")).not.toBeInTheDocument();

    await user.click(within(tabs).getByRole("tab", { name: /Drafts/ }));
    expect(within(screen.getByRole("table")).getByText("Quiz 1 — draft")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).queryByText("Série 6 — SPI")).not.toBeInTheDocument();
    expect(localStorage.getItem("quiz-activities-tab")).toBe("drafts");

    await user.click(within(tabs).getByRole("tab", { name: /Ended/ }));
    await user.click(within(screen.getByRole("table")).getByText("Test 0"));
    expect(navigate).toHaveBeenLastCalledWith({ view: "results", evaluationId: DONE.id });
    // The live block stays above the tabs, whichever is open.
    expect(screen.getByRole("region", { name: "Live now" })).toBeInTheDocument();
  });

  it("sums up what runs and whom it involves, and each tile leads to its rows", async () => {
    const user = userEvent.setup();
    const GRADING = activity(8, { title: "Test 1", state: "grading", closedAt: liveAt(-60 * MIN), closedBy: "server" });
    render([...ALL, GRADING, LAB]);
    const open = await screen.findByRole("button", { name: /^In progress/ });
    expect(open).toHaveTextContent(/^In progress\s*4/);
    expect(await within(open).findByText("42 students involved")).toBeInTheDocument();
    const toRelease = screen.getByRole("button", { name: /^Results to release/ });
    expect(toRelease).toHaveTextContent(/^Results to release\s*1/);

    await user.click(toRelease);
    expect(screen.getByRole("tab", { name: /Ended/, selected: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Results not released", pressed: true })).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("Test 1")).toBeInTheDocument();
    expect(within(table).queryByText("Test 0")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Projects in progress/ }));
    expect(screen.getByRole("tab", { name: /In progress & upcoming/, selected: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project", pressed: true })).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("Labo 2 — pointeurs")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).queryByText("Quiz 3 — pointers")).not.toBeInTheDocument();
  });

  it("says so when the open tab holds nothing", async () => {
    render([DONE]);
    expect(await screen.findByText("Nothing in progress or planned")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Ended\s*1/ })).toBeInTheDocument();
  });

  it("dates a row by its distance, and marks the poll a teacher ended by hand", async () => {
    const ended = activity(6, {
      title: "C'est quoi un BDFL",
      mode: "poll",
      state: "closed",
      startedAt: liveAt(-3 * 24 * 60 * MIN),
      closedAt: liveAt(-3 * 24 * 60 * MIN + 10 * MIN),
      closedBy: "teacher",
    });
    const user = userEvent.setup();
    render([NEXT, DONE, ended]);
    const next = within(await screen.findByRole("table")).getByText("Série 6 — SPI").closest("tr")!;
    expect(within(next).getByText("in 7 days")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /Ended/ }));
    const table = screen.getByRole("table");
    const row = within(table).getByText("C'est quoi un BDFL").closest("tr")!;
    expect(within(row).getAllByText("3 days ago")).toHaveLength(2);
    expect(within(row).getByText("Closed by hand")).toBeInTheDocument();
    expect(within(table).getAllByText("Closed by hand")).toHaveLength(1);
  });

  it("filters by type within the tab, and says how many are left", async () => {
    const user = userEvent.setup();
    render();
    const table = await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "Exercise" }));
    expect(within(table).queryByText("Quiz 3 — pointers")).not.toBeInTheDocument();
    expect(within(table).getByText("Série 5 — UART")).toBeInTheDocument();
    expect(screen.getByText("2 of 4 activities")).toBeInTheDocument();
    // The counts of the tabs follow the chips.
    expect(screen.getByRole("tab", { name: /Ended\s*0/ })).toBeInTheDocument();

    // A filter that leaves the tab empty says so, and clears in one click.
    await user.click(screen.getByRole("tab", { name: /Ended/ }));
    expect(await screen.findByText("Nothing matches these filters")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear the filters" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("switches to cards and to the schedule, and remembers the choice", async () => {
    const user = userEvent.setup();
    render();
    await screen.findByRole("table");

    await user.click(screen.getByRole("radio", { name: "Cards" }));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Série 6 — SPI" })).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Schedule" }));
    expect(screen.getByText(/This week/)).toBeInTheDocument();
    // The open series (opened days ago) is this week's, never behind the fold.
    expect(screen.getByText("Série 5 — UART")).toBeInTheDocument();
    expect(screen.getByText(/Next week/)).toBeInTheDocument();
    // On the Ended tab, the weeks already over fold under one button.
    await user.click(screen.getByRole("tab", { name: /Ended/ }));
    expect(screen.queryByText("Test 0")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Show the/ }));
    expect(screen.getByText("Test 0")).toBeInTheDocument();
    expect(localStorage.getItem("quiz-activities-view")).toBe("schedule");
  });

  it("offers the poll launcher when there is no activity at all", async () => {
    const user = userEvent.setup();
    const { navigate } = render([]);
    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start a poll" }));
    expect(navigate).toHaveBeenCalledWith({ view: "polls" });
  });

  it("shows the error with a retry", async () => {
    mockFetch({ "GET /app/api/activities": fail(500, { message: "boom" }) });
    renderWithProviders(<ActivitiesPage navigate={vi.fn()} />);
    expect(await screen.findByText("Could not load your activities")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("speaks French", async () => {
    mockFetch({ "GET /app/api/activities": ok(ALL) });
    renderWithProviders(<ActivitiesPage navigate={vi.fn()} />, { locale: "fr" });
    expect(await screen.findByRole("heading", { name: "Activités" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "En direct" })).toBeInTheDocument();
  });

  it("keeps a two-week take-home opened last week in view on the schedule", async () => {
    const user = userEvent.setup();
    const twoWeeks = activity(6, {
      title: "Série 4 — deux semaines",
      mode: "exercise",
      takeHome: true,
      state: "running",
      opensAt: liveAt(-9 * 24 * 60 * MIN),
      startedAt: liveAt(-9 * 24 * 60 * MIN),
      closesAt: liveAt(5 * 24 * 60 * MIN),
    });
    render([twoWeeks, DONE]);
    await screen.findByRole("table");
    await user.click(screen.getByRole("radio", { name: "Schedule" }));
    expect(thisWeek().getByText("Série 4 — deux semaines")).toBeInTheDocument();
    expect(screen.queryByText("Test 0")).not.toBeInTheDocument();
  });

  describe("with projects (M3-10)", () => {
    it("lists a project beside the evaluations, never live, and opens its page", async () => {
      const user = userEvent.setup();
      const { navigate } = render([...ALL, LAB, LAB3]);
      const live = await liveBlock();
      expect(within(live).queryByText("Labo 2 — pointeurs")).not.toBeInTheDocument();
      const table = screen.getByRole("table");
      const row = within(table).getByText("Labo 2 — pointeurs").closest("tr")!;
      expect(within(row).getByText("published")).toBeInTheDocument();
      // No overflow menu: its actions live on its page (M3-12).
      expect(within(row).queryByRole("button", { name: /Actions/ })).not.toBeInTheDocument();
      await user.click(within(table).getByText("Labo 2 — pointeurs"));
      expect(navigate).toHaveBeenLastCalledWith({ view: "project", id: LAB.id });
    });

    it("offers a Project chip only when there is a project, and filters by it", async () => {
      const user = userEvent.setup();
      render([...ALL, LAB, LAB3]);
      const table = await screen.findByRole("table");
      await user.click(screen.getByRole("button", { name: "Project" }));
      expect(within(table).queryByText("Quiz 3 — pointers")).not.toBeInTheDocument();
      expect(within(table).getByText("Labo 2 — pointeurs")).toBeInTheDocument();
      expect(screen.getByText("1 of 5 activities")).toBeInTheDocument();
      // Another type pressed beside it adds its rows; the projects stay.
      await user.click(screen.getByRole("button", { name: "Exam" }));
      expect(within(table).getByText("Quiz 3 — pointers")).toBeInTheDocument();
      expect(within(table).getByText("Labo 2 — pointeurs")).toBeInTheDocument();
      // The draft project waits under Drafts.
      await user.click(screen.getByRole("tab", { name: /Drafts/ }));
      expect(within(screen.getByRole("table")).getByText("Labo 3")).toBeInTheDocument();
    });

    it("draws a type chip only for a type that has rows", async () => {
      render([EXAM, SERIES]);
      await screen.findByRole("table");
      expect(screen.getByRole("button", { name: "Exam" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Exercise" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Poll" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Project" })).not.toBeInTheDocument();
    });

    it("shows a project in the cards and on the schedule", async () => {
      const user = userEvent.setup();
      render([LAB, DONE]);
      await screen.findByRole("table");
      await user.click(screen.getByRole("radio", { name: "Cards" }));
      expect(screen.getByRole("button", { name: "Labo 2 — pointeurs" })).toBeInTheDocument();
      await user.click(screen.getByRole("radio", { name: "Schedule" }));
      // Published, it is this week's business, like an open series.
      expect(thisWeek().getByText("Labo 2 — pointeurs")).toBeInTheDocument();
    });
  });
});
