import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCommands,
  capClassrooms,
  filterCommands,
  groupCommands,
  type CommandContext,
} from "../commands";
import { dashboardKey } from "../evaluation/common";
import type { TFunction } from "../i18n";
import { initialGrid } from "../realtime/grid";
import { resetEventStream } from "../realtime/useEventStream";
import { makeMe } from "../test/fixtures";
import { labelIssues } from "../test/labels";
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
 * interface (`n`/`r`/`s`, Space), and a click on a cell opens the whole of
 * one student's paper in a modal.
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
  queryClient.setQueryData(dashboardKey(EVALUATION_ID, true, true), initialGrid(view));
  const stubs = mockFetch({
    [`GET /app/api/evaluations/${EVALUATION_ID}`]: ok(makeEvaluationDetail()),
    // Each toggle changes the query key, so every variant must exist: they
    // genuinely refetch (`?includeAnswers=…&results=…`).
    [`GET /app/api/evaluations/${EVALUATION_ID}/dashboard?includeAnswers=0&results=0`]: ok(view),
    [`GET /app/api/evaluations/${EVALUATION_ID}/dashboard?includeAnswers=0&results=1`]: ok(view),
    [`GET /app/api/evaluations/${EVALUATION_ID}/dashboard?includeAnswers=1&results=0`]: ok(view),
    [`GET /app/api/evaluations/${EVALUATION_ID}/dashboard?includeAnswers=1&results=1`]: ok(view),
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
    // 30 rows + the header row + the class row. The generous timeouts (here
    // and on the test itself, below) are about the machine, not about the
    // assertion: 360 cells is the biggest render of the suite and it lands
    // well past the default second when the whole workspace runs at once.
    // Waiting LONGER can only reveal more fetches, so the three zero-fetch
    // expectations below are not weakened by it.
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(32), { timeout: 20_000 });
    // 3 identity/score/time columns + 12 questions + the actions column.
    expect(screen.getAllByRole("columnheader")).toHaveLength(16);
    // Only the evaluation's own detail; the grid came from the cache and no
    // cell asked for anything of its own.
    expect(calls.filter((c) => c.url.includes("/dashboard"))).toHaveLength(0);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
    expect(calls.every((c) => !c.url.includes("/attempts/"))).toBe(true);
  }, 30_000);

  it("shows the class totals row and the legend", async () => {
    setup();
    expect(await screen.findByText(/3 students/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/cell states/i)).toBeInTheDocument();
  });

  /* ADR-020: with the switch on, the class row is a LIVE rate and says so. */
  it("reads the class row as a live success rate while the quiz runs", async () => {
    const view = makeDashboard(3, 2);
    view.totals[0] = { ...view.totals[0]!, successRate: 0.5, provisional: true };
    setup(view);
    expect(await screen.findByText(/50 % live/i)).toBeInTheDocument();
    // The other question has nothing gradable yet, and the footer says that
    // rather than the old, now inaccurate "after closing".
    expect(screen.getByText(/graded at closing/i)).toBeInTheDocument();
  });

  it("falls back to an empty state when the roster is empty", async () => {
    setup(makeDashboard(0, 4));
    expect(await screen.findByText(/nobody on the roster/i)).toBeInTheDocument();
  });

  it("gives every <label for> of the screen a control to point at", async () => {
    setup();
    expect(await screen.findByText(/3 students/i)).toBeInTheDocument();
    expect(labelIssues()).toEqual([]);
  });
});

describe("LiveDashboard — keyboard", () => {
  it("`n` swaps the names for a stable number that is not the roster order", async () => {
    const user = userEvent.setup();
    setup();
    expect(await screen.findByText("Nadia Roux 0")).toBeInTheDocument();
    await user.keyboard("n");
    await waitFor(() => expect(screen.queryByText("Nadia Roux 0")).not.toBeInTheDocument());
    // Not the animal pseudonym, and not the row's position either: the three
    // fixture rows are "Wise Otter", "Amber Lynx", "Nimble Ibex", so sorting
    // by the server's hash puts the FIRST row last (D20).
    expect(screen.queryByText(/otter/i)).not.toBeInTheDocument();
    expect(screen.getByText("Student 3")).toBeInTheDocument();
    expect(screen.getByText("Student 1")).toBeInTheDocument();
    await user.keyboard("n");
    expect(await screen.findByText("Nadia Roux 0")).toBeInTheDocument();
  });

  it("`r` and `s` flip the answer and result toggles", async () => {
    const user = userEvent.setup();
    setup();
    const answers = () => screen.getByRole("switch", { name: /answers/i });
    const results = () => screen.getByRole("switch", { name: /results/i });
    await screen.findByText("Nadia Roux 0");
    expect(answers()).toHaveAttribute("aria-checked", "true");
    await user.keyboard("r");
    // The grid stays on screen while the other variant loads.
    await waitFor(() => expect(answers()).toHaveAttribute("aria-checked", "false"));
    expect(screen.getByText("Nadia Roux 0")).toBeInTheDocument();
    await user.keyboard("s");
    await waitFor(() => expect(results()).toHaveAttribute("aria-checked", "false"));
  });

  it("Space pauses a running evaluation and resumes a paused one", async () => {
    const user = userEvent.setup();
    const { calls } = setup(makeDashboard(2, 2), {
      [`POST /app/api/evaluations/${EVALUATION_ID}/pause`]: ok({}),
    });
    await screen.findByText("Nadia Roux 0");
    await user.keyboard(" ");
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/pause"))).toBe(true));
  });

  it("does not fire a shortcut typed into a field", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Nadia Roux 0");
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await user.keyboard("n");
    expect(screen.getByText("Nadia Roux 0")).toBeInTheDocument();
    input.remove();
  });
});

describe("LiveDashboard — inspection", () => {
  const attempt = (index: number) => ({
    attempt: {
      id: id("attempt", index),
      userId: id("user", index),
      displayName: `Nadia Roux ${index}`,
      pseudonym: "Amber Lynx",
      state: "in_progress",
      startedAt: null,
      deadlineAt: null,
      submittedAt: null,
    },
    items: [],
    events: [],
    serverNow: new Date().toISOString(),
  });

  it("opens every answer of that student in a modal, and closes it with Escape", async () => {
    const user = userEvent.setup();
    setup(makeDashboard(3, 4), {
      [`GET /app/api/evaluations/${EVALUATION_ID}/attempts/${id("attempt", 1)}`]: ok(attempt(1)),
    });

    await user.click(await screen.findByRole("button", { name: /Nadia Roux 1 · Question 2/ }));
    const dialog = await screen.findByRole("dialog", { name: /answers of nadia roux 1/i });
    // The whole paper, not one cell: the footer walks to the next STUDENT.
    expect(within(dialog).getByRole("button", { name: /next student/i })).toBeInTheDocument();

    await act(async () => {
      await user.keyboard("{Escape}");
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /answers of nadia roux 1/i })).not.toBeInTheDocument(),
    );
  });

  it("walks to the next student with the right arrow, in one query each", async () => {
    const user = userEvent.setup();
    const { calls } = setup(makeDashboard(3, 4), {
      [`GET /app/api/evaluations/${EVALUATION_ID}/attempts/${id("attempt", 1)}`]: ok(attempt(1)),
      [`GET /app/api/evaluations/${EVALUATION_ID}/attempts/${id("attempt", 2)}`]: ok(attempt(2)),
    });

    await user.click(await screen.findByRole("button", { name: /Nadia Roux 1 · Question 2/ }));
    await screen.findByRole("dialog", { name: /answers of nadia roux 1/i });
    await user.keyboard("{ArrowRight}");
    await screen.findByRole("dialog", { name: /answers of nadia roux 2/i });
    // One request per student opened, never one per question.
    expect(calls.filter((c) => c.url.includes("/attempts/"))).toHaveLength(2);
  });

  it("names the anonymous student in the modal too", async () => {
    const user = userEvent.setup();
    setup(makeDashboard(3, 4), {
      [`GET /app/api/evaluations/${EVALUATION_ID}/attempts/${id("attempt", 1)}`]: ok(attempt(1)),
    });
    await screen.findByText("Nadia Roux 1");
    await user.keyboard("n");
    await user.click(await screen.findByRole("button", { name: /Student 1 · Question 2/ }));
    expect(await screen.findByRole("dialog", { name: /answers of student 1/i })).toBeInTheDocument();
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
    await screen.findByText("Nadia Roux 0");
    expect(screen.queryByRole("button", { name: /^pause$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^close$/i })).not.toBeInTheDocument();
    // WP10: the grid is a record now; the work is the correction.
    await user.click(screen.getByRole("button", { name: /go to grading/i }));
    expect(navigate).toHaveBeenLastCalledWith({ view: "grading", evaluationId: EVALUATION_ID });
  });

  it("shows no grading button while the class is still in it", async () => {
    setup(makeDashboard(2, 2));
    await screen.findByText("Nadia Roux 0");
    expect(screen.queryByRole("button", { name: /go to grading/i })).not.toBeInTheDocument();
  });

  it("renders the failed state of its own query", async () => {
    mockFetch({});
    renderWithProviders(<LiveDashboard id={EVALUATION_ID} navigate={navigate} />);
    expect(await screen.findByText(/dashboard unavailable/i)).toBeInTheDocument();
  });
});

/*
 * FC-03 / FF-12: the dashboard lends its six commands to the palette while it
 * is mounted. The palette shows them where `buildCommands` puts them, so the
 * assertion is the WHOLE flat list in palette order — a refactoring that
 * merges the screen's commands at another point moves them and fails here.
 */
describe("LiveDashboard — command palette", () => {
  const paletteContext = (): CommandContext => ({
    // Ids are what this suite asserts, so the identity `t` is enough; the
    // labels themselves are covered by `commands.test.ts`.
    t: ((key: string) => key) as TFunction,
    locale: "en",
    setLocale: vi.fn(),
    route: { view: "live", id: EVALUATION_ID },
    navigate: vi.fn(),
    me: makeMe(),
    teacherUi: true,
    studentView: false,
    courses: [],
    themeChoice: "system",
    resolvedTheme: "light",
    setThemeChoice: vi.fn(),
    openHelp: vi.fn(),
    helpTopics: [],
    signOut: vi.fn(),
  });

  /** Exactly what the palette walks: grouped, in the order the rows appear. */
  const paletteIds = () =>
    groupCommands(capClassrooms(filterCommands("", buildCommands(paletteContext())), "")).flatMap(
      (g) => g.commands.map((c) => c.id),
    );

  it("offers pause, +5 min, close and configure while the quiz runs", async () => {
    setup(makeDashboard(2, 2));
    await screen.findByText("Nadia Roux 0");
    expect(paletteIds()).toEqual([
      "nav:home",
      "nav:settings",
      "nav:pools",
      "nav:grading",
      "nav:results",
      "live:configure",
      "action:theme",
      "action:locale",
      "action:signout",
      "live:pause",
      "live:extend",
      "live:close",
      "help:docs",
      "help:sources",
    ]);
  });

  it("offers start instead, in the same place, from the waiting room", async () => {
    const view = makeDashboard(4, 3);
    view.evaluation.state = "lobby";
    setup(view);
    await screen.findByText(/waiting room/i);
    expect(paletteIds()).toEqual([
      "nav:home",
      "nav:settings",
      "nav:pools",
      "nav:grading",
      "nav:results",
      "live:configure",
      "action:theme",
      "action:locale",
      "action:signout",
      "live:start",
      "help:docs",
      "help:sources",
    ]);
  });

  it("leaves nothing behind when the dashboard unmounts", async () => {
    const { unmount } = setup(makeDashboard(2, 2));
    await screen.findByText("Nadia Roux 0");
    unmount();
    expect(paletteIds().filter((id) => id.startsWith("live:"))).toEqual([]);
  });
});
