import { QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { meKey } from "../queryKeys";
import { resetEventStream } from "../realtime/useEventStream";
import { makeQueryClient } from "../test/render";
import { STATION_END_MS, useStationSessionWatch } from "./navigation";

/** A minimal EventSource: opened and failed by hand. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  readyState = 0;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {}
}

function Probe({ onStation }: { onStation: boolean }) {
  useStationSessionWatch(onStation);
  return null;
}

function mount(onStation: boolean) {
  const client = makeQueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <Probe onStation={onStation} />
    </QueryClientProvider>,
  );
  return invalidate;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  resetEventStream();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a kiosk station hears its session end (ADR-051 §7)", () => {
  it("asks for the session again once its stream dropped, after the closed screen's time", async () => {
    const invalidate = mount(true);
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.readyState = 1;
      es.onopen?.();
    });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(invalidate).not.toHaveBeenCalled();
    // The server ended the session and closed its stream.
    act(() => es.onerror?.());
    await act(() => vi.advanceTimersByTimeAsync(STATION_END_MS - 1));
    expect(invalidate).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: meKey });
  });

  it("does not join the stream at all off a station", async () => {
    const invalidate = mount(false);
    expect(FakeEventSource.instances).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(invalidate).not.toHaveBeenCalled();
  });
});
