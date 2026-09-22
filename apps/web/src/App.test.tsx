import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttemptOrLobby, LobbyView } from "@quiz/contracts";

import App from "./App";
import { resetEventStream } from "./realtime/useEventStream";
import { makeMe } from "./test/fixtures";
import { mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * Where the frame's view switch LANDS (ADR-018 addendum).
 *
 * The scenario that asked for this: the teacher put themselves on the roster,
 * launched the evaluation from the live dashboard — and then had no way into
 * it, because the only "View as student" button lived on the configuration
 * page, one screen away. Flipping the switch on the live dashboard must open
 * that evaluation's own student route, and flipping it back must return to
 * the dashboard.
 */

const EVAL = "11111111-1111-4111-8111-111111111111";

/** No SSE in a component test; `useLiveUpdates` opens one on every page. */
class FakeStream {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const lobby: AttemptOrLobby = {
  kind: "lobby",
  view: {
    evaluation: { id: EVAL, title: "Quiz 3 — Pointers", state: "lobby", announcedDurationS: 1200 },
    present: 3,
    enrolled: 6,
    timeBonusPercent: 0,
    serverNow: "2026-09-20T10:00:00.000Z",
  } satisfies LobbyView,
};

function render(route: string) {
  vi.stubGlobal("EventSource", FakeStream);
  const mock = mockFetch({
    "GET /app/api/me": ok(makeMe({ role: "teacher" })),
    "GET /app/api/courses": ok([]),
    "GET /app/api/pools": ok([]),
    [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(lobby),
  });
  return { ...mock, ...renderWithProviders(<App />, { route }) };
}

afterEach(() => {
  resetEventStream();
  sessionStorage.clear();
  // Only EventSource: `vi.unstubAllGlobals()` would also drop the stubs the
  // jsdom setup installs once per file (`matchMedia`, `ResizeObserver`).
  vi.stubGlobal("EventSource", undefined);
});

const viewSwitch = () => within(screen.getByRole("radiogroup", { name: "View as" }));

describe("the frame's view switch", () => {
  it("joins the evaluation the teacher is running", async () => {
    const { calls } = render(`/evaluations/${EVAL}/live`);
    await waitFor(() => expect(screen.getByRole("radiogroup", { name: "View as" })).toBeVisible());

    await userEvent.click(viewSwitch().getByRole("radio", { name: "Student" }));

    // The student's own route for THAT evaluation: the server decides between
    // the lobby and the player, exactly as it does for a student.
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.url.endsWith(`/evaluations/${EVAL}/attempt`)),
      ).toBe(true),
    );
    expect(window.location.pathname).toBe(`/take/${EVAL}`);
    expect(await screen.findByText("Quiz 3 — Pointers")).toBeVisible();
  });

  it("lands on the student home from a page with no student twin, and comes back to it", async () => {
    render("/pools");
    await waitFor(() => expect(screen.getByRole("radiogroup", { name: "View as" })).toBeVisible());

    await userEvent.click(viewSwitch().getByRole("radio", { name: "Student" }));
    await waitFor(() => expect(window.location.pathname).toBe("/"));

    // And back: the page the walk started from, not the teacher home.
    await userEvent.click(viewSwitch().getByRole("radio", { name: "Teacher" }));
    await waitFor(() => expect(window.location.pathname).toBe("/pools"));
  });
});
