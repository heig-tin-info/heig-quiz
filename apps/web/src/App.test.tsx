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
    conditions: { announced: [], imposed: [] },
    present: 3,
    enrolled: 6,
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

    // The attempt has no frame, so the banner carries the way back — without
    // handing the attempt in first.
    await userEvent.click(screen.getByRole("button", { name: "Back to teacher view" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/evaluations/${EVAL}/live`));
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

describe("the student's Courses and classroom page (M5-02, F-ORG-14/15)", () => {
  it("keeps the teacher view on /courses", async () => {
    const { calls } = render("/courses");
    expect(
      await screen.findByText("A course holds its staff, its classrooms and its question pool."),
    ).toBeVisible();
    expect(window.location.pathname).toBe("/courses");
    expect(calls.some((c) => c.url.startsWith("/app/api/student/"))).toBe(false);
  });

  it("opens the student's page of a classroom at the teacher's address, in every build", async () => {
    vi.stubGlobal("EventSource", FakeStream);
    mockFetch({
      "GET /app/api/me": ok(makeMe({ role: "student" })),
      "GET /app/api/student/classrooms/r1": ok({
        classroom: {
          id: "r1",
          name: "PRG1-2026",
          period: "2026-A",
          courseName: "Programmation C",
          courseCode: "PRG1",
          teachers: [],
          timeBonusPercent: 0,
          archived: false,
        },
        activities: { polls: [], groupSets: [], open: [], upcoming: [], past: [] },
        hasJournal: true,
        hasGroups: false,
        serverNow: new Date().toISOString(),
      }),
    });
    renderWithProviders(<App />, { route: "/classrooms/r1" });
    expect(await screen.findByRole("heading", { level: 1, name: "PRG1-2026" })).toBeVisible();
  });
});

describe("a Safe Exam Browser session (ADR-027)", () => {
  it("shows its own evaluation and nothing else of the portal", async () => {
    vi.stubGlobal("EventSource", FakeStream);
    const { calls } = mockFetch({
      "GET /app/api/me": ok(makeMe({ session: { kind: "seb", evaluationId: EVAL, readOnly: false, superPowersUntil: null, superPowersAvailable: false } })),
      [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(lobby),
    });
    // Another evaluation's address still opens the one the session is for.
    renderWithProviders(<App />, { route: "/take/22222222-2222-4222-8222-222222222222" });
    expect(await screen.findByText("Quiz 3 — Pointers")).toBeVisible();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(calls.every((c) => !c.url.includes("2222"))).toBe(true);

    // Leaving the waiting room leads nowhere but back.
    await userEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(await screen.findByText("You have left the exam")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to the exam" }));
    expect(await screen.findByText("Quiz 3 — Pointers")).toBeVisible();
  });
});

describe("an impersonation session (ADR-034)", () => {
  it("says whom the admin acts as, on every page, and ends by signing out", async () => {
    vi.stubGlobal("EventSource", FakeStream);
    const { calls } = mockFetch({
      "GET /app/api/me": ok(
        makeMe({
          role: "student",
          givenName: "Léa",
          familyName: "Rochat",
          session: {
            kind: "impersonation",
            evaluationId: null,
            readOnly: true,
            superPowersUntil: null,
            superPowersAvailable: false,
          },
        }),
      ),
      "GET /app/api/student/classrooms": ok([]),
      "POST /app/auth/logout": ok(undefined),
    });
    renderWithProviders(<App />, { route: "/" });
    const banner = await screen.findByRole("region", { name: "Acting as Léa Rochat, read only." });
    await userEvent.click(within(banner).getByRole("button", { name: "End" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/app/auth/logout")).toBe(true));
  });
});
