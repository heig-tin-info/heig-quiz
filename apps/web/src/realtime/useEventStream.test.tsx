import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SERVER_EVENT_NAMES, type ServerEvent } from "@quiz/contracts";

import { useGradingProgress } from "../grading/progress";
import { gradingProgressKey } from "../queryKeys";
import { EVALUATION_ID, liveAt } from "../test/live-fixtures";
import { makeQueryClient, mockFetch, ok } from "../test/render";
import {
  NAMED_EVENTS,
  resetEventStream,
  SILENCE_MS,
  useEventStream,
  type EventStreamOptions,
} from "./useEventStream";

/*
 * The stream is tested against a fake `EventSource` because the thing worth
 * asserting is not "does the browser parse SSE" but the four decisions this
 * module makes: one connection for the whole page, named frames dispatched by
 * name, a frame the contracts reject dropped rather than thrown, and a
 * connection that went silent reopened by us instead of waited on.
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }

  /** The names this connection actually subscribed to. */
  subscribed(): string[] {
    return [...this.listeners.keys()];
  }

  removeEventListener() {}

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.();
  }

  /** Delivers one NAMED frame, the way the server writes it. */
  send(event: ServerEvent) {
    const frame = new MessageEvent(event.type, { data: JSON.stringify(event) });
    for (const fn of this.listeners.get(event.type) ?? []) fn(frame);
  }

  /** Delivers one UNNAMED frame — the inherited hint (WP5 deviation W5-7). */
  sendUnnamed(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

function Probe(options: EventStreamOptions) {
  const { connected } = useEventStream(options);
  return <span data-testid="connected">{String(connected)}</span>;
}

const live = () => FakeEventSource.instances.filter((s) => !s.closed);

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  resetEventStream();
  vi.useRealTimers();
});

describe("useEventStream", () => {
  it("opens one connection on the watched subject", () => {
    render(<Probe watch={`evaluation:${EVALUATION_ID}`} />);
    expect(live()).toHaveLength(1);
    expect(live()[0]!.url).toBe(`/app/api/events?watch=evaluation%3A${EVALUATION_ID}`);
  });

  it("serves two subscribers from ONE connection", () => {
    render(
      <>
        <Probe />
        <Probe watch={`evaluation:${EVALUATION_ID}`} />
      </>,
    );
    expect(live()).toHaveLength(1);
    expect(live()[0]!.url).toContain("watch=");
  });

  it("dispatches every named event, by name", () => {
    const onEvent = vi.fn();
    render(<Probe watch={`evaluation:${EVALUATION_ID}`} onEvent={onEvent} />);
    act(() =>
      live()[0]!.send({
        type: "dashboard.cell",
        evaluationId: EVALUATION_ID,
        attemptId: EVALUATION_ID,
        itemId: EVALUATION_ID,
        status: "done",
        revision: 2,
        points: null,
        summary: "B",
        verdict: null,
      }),
    );
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]![0]).toMatchObject({ type: "dashboard.cell", revision: 2 });
  });

  it("subscribes to the whole named grammar of the contracts", () => {
    render(<Probe watch={`evaluation:${EVALUATION_ID}`} />);
    expect([...NAMED_EVENTS]).toContain("snapshot");
    expect([...NAMED_EVENTS]).toContain("clock");
    expect([...NAMED_EVENTS]).toContain("lobby.count");
    // The connection subscribes to the contracts' own list, so a new member of
    // `ServerEvent` is listened for without a second list being edited (FC-09).
    expect(live()[0]!.subscribed().sort()).toEqual([...SERVER_EVENT_NAMES].sort());
    // The hint has no name; `onmessage` is the only way in.
    expect(live()[0]!.subscribed()).not.toContain("hint");
  });

  it("delivers grading.progress, the frame the grading panel reads", () => {
    const onEvent = vi.fn();
    render(<Probe watch={`evaluation:${EVALUATION_ID}`} onEvent={onEvent} />);
    act(() =>
      live()[0]!.send({
        type: "grading.progress",
        evaluationId: EVALUATION_ID,
        done: 3,
        total: 8,
        phase: "auto",
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "grading.progress", done: 3, total: 8 }),
    );
  });

  it("the grading progress joins the page's connection and writes the cache", async () => {
    mockFetch({
      [`GET /app/api/evaluations/${EVALUATION_ID}/grading/progress`]: ok({
        done: 0,
        total: 8,
        pending: { runner: 1, llm: 0 },
        failed: 0,
      }),
    });
    const queryClient = makeQueryClient();
    function Panel() {
      useGradingProgress(EVALUATION_ID);
      return null;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
        <Panel />
      </QueryClientProvider>,
    );
    // The shell's hint stream and the panel share ONE socket (FF-01).
    expect(live()).toHaveLength(1);
    await waitFor(() =>
      expect(queryClient.getQueryData(gradingProgressKey(EVALUATION_ID))).toBeDefined(),
    );
    act(() =>
      live()[0]!.send({
        type: "grading.progress",
        evaluationId: EVALUATION_ID,
        done: 5,
        total: 8,
        phase: "auto",
      }),
    );
    expect(queryClient.getQueryData(gradingProgressKey(EVALUATION_ID))).toEqual({
      done: 5,
      total: 8,
      pending: { runner: 1, llm: 0 },
      failed: 0,
    });
  });

  it("routes the snapshot, the clock and the unnamed hint to their handlers", () => {
    const onSnapshot = vi.fn();
    const onClock = vi.fn();
    const onHint = vi.fn();
    render(
      <Probe
        watch={`evaluation:${EVALUATION_ID}`}
        onSnapshot={onSnapshot}
        onClock={onClock}
        onHint={onHint}
      />,
    );
    const es = live()[0]!;
    act(() => {
      es.send({ type: "clock", serverNow: liveAt(0) });
      es.send({
        type: "snapshot",
        serverNow: liveAt(0),
        subject: `evaluation:${EVALUATION_ID}`,
        state: { hello: true },
      });
      es.sendUnnamed({ type: "hint", kinds: ["evaluations"], notice: null });
    });
    expect(onClock).toHaveBeenCalledWith(liveAt(0));
    expect(onSnapshot).toHaveBeenCalledWith({ hello: true }, liveAt(0));
    expect(onHint).toHaveBeenCalledTimes(1);
  });

  it("drops a frame the contracts refuse instead of throwing", () => {
    const onEvent = vi.fn();
    render(<Probe watch={`evaluation:${EVALUATION_ID}`} onEvent={onEvent} />);
    const es = live()[0]!;
    act(() => {
      es.onmessage?.(new MessageEvent("message", { data: "not json at all" }));
      es.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "from-2030" }) }));
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("reports the connection and refetches on (re)open", async () => {
    const onRefresh = vi.fn();
    const view = render(<Probe watch={`evaluation:${EVALUATION_ID}`} onRefresh={onRefresh} />);
    act(() => live()[0]!.open());
    await waitFor(() => expect(view.getByTestId("connected").textContent).toBe("true"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("reopens the connection after 30 s without a clock", () => {
    vi.useFakeTimers();
    render(<Probe watch={`evaluation:${EVALUATION_ID}`} />);
    const first = FakeEventSource.instances[0]!;
    act(() => {
      first.open();
      first.send({ type: "clock", serverNow: liveAt(0) });
    });
    // Still inside the window: the same socket is kept.
    act(() => void vi.advanceTimersByTime(SILENCE_MS - 1_000));
    expect(first.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
    // Past it: we stop believing in this socket and open another.
    act(() => void vi.advanceTimersByTime(6_000));
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("a clock keeps the connection alive indefinitely", () => {
    vi.useFakeTimers();
    render(<Probe watch={`evaluation:${EVALUATION_ID}`} />);
    const first = FakeEventSource.instances[0]!;
    act(() => first.open());
    for (let i = 0; i < 10; i += 1) {
      act(() => {
        vi.advanceTimersByTime(10_000);
        first.send({ type: "clock", serverNow: liveAt(0) });
      });
    }
    expect(first.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("reopens when the watched subject changes, and closes when nobody watches", () => {
    const view = render(<Probe watch={`evaluation:${EVALUATION_ID}`} />);
    expect(live()).toHaveLength(1);
    view.rerender(<Probe watch={`attempt:${EVALUATION_ID}`} />);
    expect(live()[0]!.url).toContain("attempt");
    view.unmount();
    expect(live()).toHaveLength(0);
  });

  it("stays off the wire when it is disabled", () => {
    render(<Probe enabled={false} />);
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
