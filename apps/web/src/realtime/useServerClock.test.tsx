import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useServerClock } from "./useServerClock";

/*
 * The hook around `clock.ts`: what it exposes to a countdown, and what it
 * refuses to re-render for. The arithmetic itself is covered in clock.test.ts.
 */

afterEach(() => vi.useRealTimers());

/** Freezes `Date.now()` at `t`, the way a fake-timer test needs. */
function freeze(t: number) {
  vi.useFakeTimers();
  vi.setSystemTime(t);
}

describe("useServerClock", () => {
  it("runs on the local clock until the first sample lands", () => {
    freeze(1_000_000);
    const { result } = renderHook(() => useServerClock());
    expect(result.current.synced).toBe(false);
    expect(result.current.offset).toBe(0);
    expect(result.current.now()).toBe(1_000_000);
  });

  it("adopts the server's time, half the round trip given back", () => {
    freeze(1_000_000);
    const { result } = renderHook(() => useServerClock());
    // The server stamped 1_030_000 and the round trip took 400 ms.
    act(() => result.current.sample(1_030_000, 400));
    expect(result.current.synced).toBe(true);
    expect(result.current.offset).toBe(30_200);
    expect(result.current.now()).toBe(1_030_200);
  });

  it("reads the ISO stamp the SSE grammar sends", () => {
    const serverNow = "2026-09-20T10:00:00.000Z";
    freeze(Date.parse(serverNow) - 5_000);
    const { result } = renderHook(() => useServerClock());
    act(() => result.current.sample(serverNow));
    expect(result.current.offset).toBe(5_000);
  });

  it("does not re-render when a sample leaves the median where it was", () => {
    freeze(2_000_000);
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useServerClock();
    });
    // The first identical sample still costs one render: React re-renders the
    // component once before it notices the state came back identical.
    act(() => result.current.sample(2_000_500));
    act(() => result.current.sample(2_000_500));
    const after = renders;
    act(() => result.current.sample(2_000_500));
    act(() => result.current.sample(2_000_500));
    expect(renders).toBe(after);
    expect(result.current.offset).toBe(500);
  });
});
