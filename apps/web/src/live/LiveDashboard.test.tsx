import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardKey } from "../evaluation/common";
import { initialGrid } from "../realtime/grid";
import { resetEventStream } from "../realtime/useEventStream";
import {
  EVALUATION_ID,
  id,
  makeDashboard,
  makeEvaluationDetail,
} from "../test/live-fixtures";
import { makeQueryClient, mockFetch, ok, renderWithProviders } from "../test/render";
import { LiveDashboard } from "./LiveDashboard";

/*
 * The dashboard, from the three angles the work package cares about: the grid
 * renders 30 x 12 WITHOUT fetching a single cell, the keyboard is the real
 * interface (`n`/`r`/`s`, Space), and a click on a cell opens the in-flow
 * inspection panel rather than a modal.
 *
 * `EventSource` is stubbed away: the query cache is seeded directly, which is
 * what a snapshot does anyway, and the stream itself is tested in
 * `realtime/useEventStream.test.tsx`.
 */

class SilentEventSource {
  onopen = null;
  onerror = null;
  onmessage = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const navigate = vi.fn();

function setup(view = makeDashboard(3, 4), extra: Record<string, ReturnType<typeof ok>> = {}) {
  const queryClient = makeQueryClient();
  queryClient.setQueryData(dashboardKey(EVALUATION_ID, true), initialGrid(view));
  const stubs = mockFetch({
    [`GET /app/api/evaluations/${EVALUATION_ID}`]: ok(makeEvaluationDetail()),
    // Turning the answers off changes the query key, so the other variant
    // must exist: the toggle genuinely refetches (`?includeAnswers=0`).
    [`GET /app/api/evaluations/${EVALUATION_ID}/dashboard?includeAnswers=0`]: ok(view),
    [`GET /app/api/evaluations/${EVALUATION_ID}/dashboard?includeAnswers=1`]: ok(view),
    ...extra,
  });
  const rendered = renderWithProviders(
    <LiveDashboard id={EVALUATION_ID} navigate={navigate} />,
    { queryClient },
  );
  return { ...rendered, ...stubs };
}

beforeEach(() => {
  vi.stubGlobal("EventSource", SilentEventSource);
});

afterEach(() => {
  resetEventStream();
});

describe("LiveDashboard — the grid", () => {
  it("renders 30 students by 12 questions without fetching one cell", async () => {
    const { calls } = setup(makeDashboard(30, 12));
    // 30 rows + the header row + the class row. The generous timeout is about
    // the machine, not about the assertion: 360 cells is the biggest render
    // of the suite and it lands well past a second when the whole workspace
    // runs at once. Waiting LONGER can only reveal more fetches, so the three
    // zero-fetch expectations below are not weakened by it.
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(32), { timeout: 15_000 });
    expect(screen.getAllByRole("columnheader")).toHaveLength(15);
    // Only the evaluation's own detail; the grid came from the cache and no
    // cell asked for anything of its own.
    expect(calls.filter((c) => c.url.includes("/dashboard"))).toHaveLength(0);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
    expect(calls.every((c) => !c.url.includes("/attempts/"))).toBe(true);
  });

  it("shows the class totals row and the legend", async () => {
    setup();
    expect(await screen.findByText(/3 students/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/cell states/i)).toBeInTheDocument();
  });

  it("falls back to an empty state when the roster is empty", async () => {
    setup(makeDashboard(0, 4));
    expect(await screen.findByText(/nobody on the roster/i)).toBeInTheDocument();
  });
});

describe("LiveDashboard — keyboard", () => {
  it("`n` swaps the names for the stable pseudonyms", async () => {
    const user = userEvent.setup();
    setup();
    expect(await screen.findByText("Student 0")).toBeInTheDocument();
    await user.keyboard("n");
    await waitFor(() => expect(screen.queryByText("Student 0")).not.toBeInTheDocument());
    expect(screen.getByText("calm heron 0")).toBeInTheDocument();
    await user.keyboard("n");
    expect(await screen.findByText("Student 0")).toBeInTheDocument();
  });

  it("`r` and `s` flip the answer and result toggles", async () => {
    const user = userEvent.setup();
    setup();
    const answers = () => screen.getByRole("switch", { name: /answers/i });
    const results = () => screen.getByRole("switch", { name: /results/i });
    await screen.findByText("Student 0");
    expect(answers()).toHaveAttribute("aria-checked", "true");
    await user.keyboard("r");
    // The grid stays on screen while the other variant loads.
    await waitFor(() => expect(answers()).toHaveAttribute("aria-checked", "false"));
    expect(screen.getByText("Student 0")).toBeInTheDocument();
    await user.keyboard("s");
    await waitFor(() => expect(results()).toHaveAttribute("aria-checked", "false"));
  });

  it("Space pauses a running evaluation and resumes a paused one", async () => {
    const user = userEvent.setup();
    const { calls } = setup(makeDashboard(2, 2), {
      [`POST /app/api/evaluations/${EVALUATION_ID}/pause`]: ok({}),
    });
    await screen.findByText("Student 0");
    await user.keyboard(" ");
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/pause"))).toBe(true));
  });

  it("does not fire a shortcut typed into a field", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Student 0");
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await user.keyboard("n");
    expect(screen.getByText("Student 0")).toBeInTheDocument();
    input.remove();
  });
});

describe("LiveDashboard — inspection", () => {
  it("opens the in-flow panel on a cell, and closes it with Escape", async () => {
    const user = userEvent.setup();
    setup(makeDashboard(3, 4), {
      [`GET /app/api/evaluations/${EVALUATION_ID}/attempts/${id("attempt", 1)}`]: ok({
        attempt: {
          id: id("attempt", 1),
          userId: id("user", 1),
          displayName: "Student 1",
          pseudonym: "calm heron 1",
          state: "in_progress",
          startedAt: null,
          deadlineAt: null,
          submittedAt: null,
        },
        items: [],
        events: [],
        serverNow: new Date().toISOString(),
      }),
    });

    await user.click(await screen.findByRole("button", { name: /Student 1 · Question 2/ }));
    // `<aside>` maps to `complementary`, which is what "in flow, beside the
    // grid" means to a screen reader.
    const panel = await screen.findByRole("complementary", { name: /answer of student 1/i });
    // In flow, not a modal: no dialog, no backdrop over the grid.
    expect(within(panel).getByText(/question 2/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("table")).toBeVisible();

    await act(async () => {
      await user.keyboard("{Escape}");
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: /answer of student 1/i }),
      ).not.toBeInTheDocument(),
    );
  });
});

describe("LiveDashboard — states", () => {
  it("shows the waiting room instead of the grid before anyone starts", async () => {
    const view = makeDashboard(4, 3);
    view.evaluation.state = "lobby";
    setup(view);
    expect(await screen.findByText(/waiting room/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start now/i })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("offers no live control once the evaluation is closed, but points at the grading", async () => {
    const user = userEvent.setup();
    const view = makeDashboard(2, 2);
    view.evaluation.state = "closed";
    setup(view);
    await screen.findByText("Student 0");
    expect(screen.queryByRole("button", { name: /^pause$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^close$/i })).not.toBeInTheDocument();
    // WP10: the grid is a record now; the work is the correction.
    await user.click(screen.getByRole("button", { name: /go to grading/i }));
    expect(navigate).toHaveBeenLastCalledWith({ view: "grading", evaluationId: EVALUATION_ID });
  });

  it("shows no grading button while the class is still in it", async () => {
    setup(makeDashboard(2, 2));
    await screen.findByText("Student 0");
    expect(screen.queryByRole("button", { name: /go to grading/i })).not.toBeInTheDocument();
  });

  it("renders the failed state of its own query", async () => {
    mockFetch({});
    renderWithProviders(<LiveDashboard id={EVALUATION_ID} navigate={navigate} />);
    expect(await screen.findByText(/dashboard unavailable/i)).toBeInTheDocument();
  });
});
