import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EvaluationActivitySummary } from "@quiz/contracts";

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

beforeEach(() => {
  localStorage.removeItem("quiz-activities-view");
});

const render = (rows: EvaluationActivitySummary[] = ALL, navigate = vi.fn()) => {
  const stub = mockFetch({ "GET /app/api/activities": ok(rows) });
  renderWithProviders(<ActivitiesPage navigate={navigate} />);
  return { navigate, ...stub };
};

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

  it("lists every activity in the table, open first, and opens a row where its classroom would", async () => {
    const user = userEvent.setup();
    const { navigate } = render();
    const table = await screen.findByRole("table");
    const titles = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.querySelector(".font-semibold")?.textContent);
    expect(titles.at(-1)).toBe("Test 0");
    expect(titles.indexOf("Série 6 — SPI")).toBeGreaterThan(titles.indexOf("Série 5 — UART"));
    await user.click(within(table).getByText("Test 0"));
    expect(navigate).toHaveBeenLastCalledWith({ view: "results", evaluationId: DONE.id });
  });

  it("filters by type and by state, and says how many are left", async () => {
    const user = userEvent.setup();
    render();
    const table = await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "Exercise" }));
    expect(within(table).queryByText("Test 0")).not.toBeInTheDocument();
    expect(within(table).getByText("Série 5 — UART")).toBeInTheDocument();
    expect(screen.getByText("2 of 5 activities")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Upcoming" }));
    expect(within(table).queryByText("Série 5 — UART")).not.toBeInTheDocument();
    expect(within(table).getByText("Série 6 — SPI")).toBeInTheDocument();

    // A filter that leaves nothing says so, and clears in one click.
    await user.click(screen.getByRole("button", { name: "Poll" }));
    await user.click(screen.getByRole("button", { name: "Exercise" }));
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
    expect(screen.getByRole("button", { name: "Test 0" })).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Schedule" }));
    expect(screen.getByText(/This week/)).toBeInTheDocument();
    // The open series (opened days ago) is this week's, never behind the fold.
    expect(screen.getByText("Série 5 — UART")).toBeInTheDocument();
    expect(screen.getByText(/Next week/)).toBeInTheDocument();
    // The weeks already over fold under one button.
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
    expect(screen.getByText("Série 4 — deux semaines")).toBeInTheDocument();
    expect(screen.queryByText("Test 0")).not.toBeInTheDocument();
  });
});
