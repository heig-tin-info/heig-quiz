import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AttemptOrLobby,
  LobbyView,
  Me,
  Notification,
  NotificationList,
  StudentHome,
} from "@quiz/contracts";

import App from "./App";
import { resetEventStream } from "./realtime/useEventStream";
import { elapse, flowingClock } from "./test/clock";
import { makeMe } from "./test/fixtures";
import { mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * Where the blanket refresh applies, decided at the one place that knows which
 * screen is on: `App`.
 *
 * `useLiveUpdates` answers a hint by invalidating what its kinds may have made
 * stale — and a `mutation` hint, the one pushed below, every active query of
 * the page, at once. That is the right reflex on a teacher screen,
 * whose data is other people's. It is the wrong one during an exam:
 * `/take/:id` is a POST behind a query (`AttemptPage`), and an invalidation
 * arriving while that POST is in flight cancels the refetch, throws the answer
 * away and leaves the waiting room on screen. A server that hinted the actor's
 * own topic on every write then fed the loop a teacher measured at ~215
 * requests per second on a student's tab.
 *
 * The student player carries its own `attempt:`/`evaluation:` watch stream,
 * which delivers the start, the deadline, the pause and the closure as typed
 * frames. It needs no hints, so it gets none.
 */

const EVAL = "11111111-1111-4111-8111-111111111111";

const me: Me = makeMe({
  id: "33333333-3333-4333-8333-333333333333",
  email: "lea.rochat@heig-vd.ch",
  givenName: "Léa",
  familyName: "Rochat",
  role: "student",
  lastLoginAt: null,
  locale: "fr",
  dateFormat: null,
});

const lobby: AttemptOrLobby = {
  kind: "lobby",
  view: {
    evaluation: { id: EVAL, title: "Quiz 3 — Pointeurs", state: "lobby", announcedDurationS: 1200 },
    navigation: "free",
    present: 3,
    enrolled: 6,
    timeBonusPercent: 0,
    serverNow: "2026-09-20T10:00:00.000Z",
  } satisfies LobbyView,
};

const home: StudentHome = {
  polls: [],
  open: [],
  upcoming: [],
  past: [],
  serverNow: "2026-09-20T10:00:00.000Z",
};

/** Enough of an `EventSource` to push one unnamed frame — the refresh hint. */
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
  /** The inherited hint: unnamed, so `onmessage` is the only way in (W5-7). */
  hint(kinds: string[] = ["mutation"]) {
    act(() => {
      this.onmessage?.({ data: JSON.stringify({ type: "hint", kinds }) } as MessageEvent);
    });
  }
}

/** The inbox the bell reads; a test pushes into it, then hints. */
const inbox: Notification[] = [];
const INBOX_URL = "GET /app/api/notifications?limit=30";

function render(route: string, who: Me = me) {
  vi.stubGlobal("EventSource", FakeStream);
  const mock = mockFetch({
    [INBOX_URL]: () =>
      ok({ items: [...inbox], unread: inbox.filter((n) => n.readAt === null).length } satisfies NotificationList),
    "GET /app/api/me": ok(who),
    "GET /app/api/student/home": ok(home),
    "GET /app/api/student/classrooms": ok([]),
    [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(lobby),
  });
  return { ...mock, ...renderWithProviders(<App />, { locale: "fr", route }) };
}

const countOf = (calls: { url: string; method: string }[], method: string, url: string) =>
  calls.filter((c) => c.method === method && c.url === url).length;

afterEach(() => {
  resetEventStream();
  streams.length = 0;
  inbox.length = 0;
  // Only EventSource: `vi.unstubAllGlobals()` would also drop the stubs the
  // jsdom setup installs once per file (`matchMedia`, `ResizeObserver`), and
  // the next test in this file would render into a browser missing them.
  vi.stubGlobal("EventSource", undefined);
});

describe("the blanket hint refresh", () => {
  it("is off on /take/:id: a hint never re-issues the entry POST", async () => {
    const { calls } = render(`/take/${EVAL}`);
    expect(await screen.findByText("Salle d'attente")).toBeInTheDocument();
    const entry = `/app/api/evaluations/${EVAL}/attempt`;
    expect(countOf(calls, "POST", entry)).toBe(1);
    const before = calls.length;

    // Every stream this screen opened is the player's own watch stream; none
    // of them is the shell's hint stream, and a hint pushed down any of them
    // must change nothing.
    flowingClock();
    for (const stream of streams) stream.hint();
    await elapse(50);

    expect(countOf(calls, "POST", entry)).toBe(1);
    expect(calls.length).toBe(before);
  });

  it("is on everywhere else: a hint refreshes the screen's queries", async () => {
    const { calls } = render("/");
    expect(await screen.findByText("Bonjour, Léa")).toBeInTheDocument();
    expect(countOf(calls, "GET", "/app/api/me")).toBe(1);

    expect(streams).toHaveLength(1);
    streams[0]!.hint();

    await waitFor(() => expect(countOf(calls, "GET", "/app/api/me")).toBe(2));
  });
});

/*
 * ADR-030 addendum §a: the App channel is the bell and the toast. A hint
 * carries no data; the `notifications` hint makes the bell re-read its
 * inbox, and what arrived in it toasts — never on a quiet page (§h).
 */
describe("a notification arriving", () => {
  const released = (id: string): Notification => ({
    id,
    payload: {
      kind: "results_released",
      evaluationId: EVAL,
      evaluationTitle: "Quiz 3 — Pointeurs",
      attemptId: "44444444-4444-4444-8444-444444444444",
    },
    createdAt: new Date().toISOString(),
    readAt: null,
  });

  it("is a toast in the reader's language, and the unread inbox of the first read is not", async () => {
    inbox.push(released("n0"));
    const { calls } = render("/");
    expect(await screen.findByText("Bonjour, Léa")).toBeInTheDocument();
    await waitFor(() => expect(countOf(calls, "GET", "/app/api/notifications?limit=30")).toBe(1));
    expect(screen.queryByText(/Les résultats de/)).toBeNull();

    inbox.unshift({ ...released("n1"), payload: { ...released("n1").payload, evaluationTitle: "Quiz 4" } } as Notification);
    streams[0]!.hint(["notifications"]);
    expect(await screen.findByText("Les résultats de « Quiz 4 » sont disponibles.")).toBeInTheDocument();
    expect(screen.queryByText(/Quiz 3/)).toBeNull();
  });

  it("is no toast on the live dashboard, which may be on a beamer; the bell still counts it", async () => {
    const teacher: Me = { ...me, role: "teacher", givenName: "Marie" };
    const { calls } = render(`/evaluations/${EVAL}/live`, teacher);
    await waitFor(() => expect(countOf(calls, "GET", "/app/api/notifications?limit=30")).toBe(1));

    flowingClock();
    inbox.unshift(released("n1"));
    streams[0]!.hint(["notifications"]);
    await waitFor(() => expect(countOf(calls, "GET", "/app/api/notifications?limit=30")).toBe(2));
    await elapse(50);
    expect(screen.queryByText(/Les résultats de/)).toBeNull();
  });
});
