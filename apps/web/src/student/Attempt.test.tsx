import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttemptOrLobby, AttemptView, LobbyView, ServerEvent } from "@quiz/contracts";

import { makeAttemptView } from "../test/attempt-fixtures";
import { elapse, flowingClock } from "../test/clock";
import { fail, mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { AttemptPage } from "./Attempt";

/*
 * `/take/:id` across the ONE moment that decides whether an exam happens: the
 * teacher presses "Start now" and the waiting room has to become the player.
 *
 * The route is a READ BEHIND A POST (deviation W5-14): the client never
 * decides that an evaluation has started, it re-asks
 * `POST /evaluations/:id/attempt` and renders what came back. That shape is
 * only safe while nothing else re-issues the same POST — a blanket
 * `invalidateQueries()` cancels the in-flight refetch, the answer is thrown
 * away, and the lobby stays on screen however many 200s the server sends.
 * That is what a teacher saw in the field, and the second test below is the
 * guard: the entry POST goes out ONCE per start.
 */

const EVAL = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";

const lobbyView: LobbyView = {
  evaluation: { id: EVAL, title: "Quiz 3 — Pointeurs", state: "lobby", announcedDurationS: 1200 },
    navigation: "free",
  present: 3,
  enrolled: 6,
  timeBonusPercent: 0,
  serverNow: "2026-09-20T10:00:00.000Z",
};

/** The paper once started: one unanswered `mcq`, a minute after the lobby. */
const attemptView: AttemptView = makeAttemptView({
  attempt: {
    id: ATTEMPT,
    startedAt: "2026-09-20T10:01:00.000Z",
    deadlineAt: "2026-09-20T10:21:00.000Z",
    serverNow: "2026-09-20T10:01:00.000Z",
  },
  evaluation: { id: EVAL },
  settings: { shuffleChoices: false },
});

/** jsdom has no EventSource; the start of an evaluation arrives on one. */
const streams: FakeStream[] = [];

class FakeStream {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor(readonly url: string) {
    streams.push(this);
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    const set = this.listeners.get(name) ?? new Set();
    set.add(fn);
    this.listeners.set(name, set);
  }
  removeEventListener(name: string, fn: (e: MessageEvent) => void) {
    this.listeners.get(name)?.delete(fn);
  }
  close() {}
  emit(event: ServerEvent) {
    act(() => {
      for (const fn of this.listeners.get(event.type) ?? []) {
        fn({ data: JSON.stringify(event) } as MessageEvent);
      }
    });
  }
}

const started: ServerEvent = {
  type: "evaluation.state",
  evaluationId: EVAL,
  state: "running",
  pausedAt: null,
  closesAt: null,
  serverNow: "2026-09-20T10:01:00.000Z",
};

/** The entry route answers the lobby until `running`, then the attempt. */
function stubs() {
  let running = false;
  const mock = mockFetch({
    [`POST /app/api/evaluations/${EVAL}/attempt`]: () =>
      ok(
        (running
          ? { kind: "attempt", view: attemptView }
          : { kind: "lobby", view: lobbyView }) satisfies AttemptOrLobby,
      ),
    [`GET /app/api/attempts/${ATTEMPT}`]: () =>
      ok({ kind: "attempt", view: attemptView } satisfies AttemptOrLobby),
    [`POST /app/api/attempts/${ATTEMPT}/position`]: noContent(),
    [`POST /app/api/attempts/${ATTEMPT}/events`]: noContent(),
  });
  return { ...mock, start: () => void (running = true) };
}

const entryCalls = (calls: { url: string; method: string }[]) =>
  calls.filter((c) => c.method === "POST" && c.url === `/app/api/evaluations/${EVAL}/attempt`);

function render() {
  vi.stubGlobal("EventSource", FakeStream);
  const mock = stubs();
  const result = renderWithProviders(<AttemptPage evaluationId={EVAL} navigate={() => {}} />, {
    locale: "fr",
    route: `/take/${EVAL}`,
  });
  return { ...result, ...mock };
}

afterEach(() => {
  streams.length = 0;
  // Only EventSource: `vi.unstubAllGlobals()` would also drop the stubs the
  // jsdom setup installs once per file (`matchMedia`, `ResizeObserver`), and
  // the next test in this file would render into a browser missing them.
  vi.stubGlobal("EventSource", undefined);
});

describe("/take/:id", () => {
  it("leaves the waiting room for question 1 when the teacher starts the evaluation", async () => {
    const { start } = render();
    expect(await screen.findByText("Salle d'attente")).toBeInTheDocument();

    start();
    streams.at(-1)!.emit(started);
    expect(await screen.findByText("Question 1")).toBeInTheDocument();
    expect(screen.queryByText("Salle d'attente")).not.toBeInTheDocument();
  });

  it("re-enters the evaluation exactly once: the entry POST never feeds itself", async () => {
    flowingClock();
    const { calls, start, queryClient } = render();
    expect(await screen.findByText("Salle d'attente")).toBeInTheDocument();
    expect(entryCalls(calls)).toHaveLength(1);

    start();
    streams.at(-1)!.emit(started);
    expect(await screen.findByText("Question 1")).toBeInTheDocument();
    expect(entryCalls(calls)).toHaveLength(2);

    // The loop the field incident produced: the POST answers 200, the server
    // hints the actor's own topic, `useLiveUpdates` invalidates everything and
    // the POST goes out again. `App` no longer mounts the hint refresh on this
    // route (`live.test.tsx`); this asserts the other half — that the player,
    // once mounted, asks for nothing more on its own.
    await elapse(50);
    expect(entryCalls(calls)).toHaveLength(2);

    // And a refetch that IS asked for stays a single round trip.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["attempt", "enter", EVAL] });
    });
    await waitFor(() => expect(entryCalls(calls)).toHaveLength(3));
  });
});


it("keeps the mounted player and its local answer across a failed background entry read", async () => {
  const { start, queryClient } = render();
  await screen.findByText("Salle d'attente");
  start();
  streams.at(-1)!.emit(started);
  await screen.findByText("Question 1");
  const input = screen.getAllByRole("radio")[0]!;
  await act(async () => { input.click(); });
  expect(input).toBeChecked();
  mockFetch({ [`POST /app/api/evaluations/${EVAL}/attempt`]: fail(503) });
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: ["attempt", "enter", EVAL] });
  });
  expect(screen.getByText("Question 1")).toBeInTheDocument();
  expect(screen.getAllByRole("radio")[0]).toBe(input);
  expect(input).toBeChecked();
});
