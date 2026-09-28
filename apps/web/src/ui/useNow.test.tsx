import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNow } from "./layers";

/*
 * `useNow` is the app's ONE ticking clock: every subscriber of a given
 * interval shares a single timer and moves in the same tick, so two
 * countdowns on one screen never show different seconds and a page with
 * thirty of them runs one interval, not thirty.
 */

function Clock({ name, read }: { name: string; read?: () => number }) {
  const now = useNow(1_000, read);
  return <span data-testid={name}>{now}</span>;
}

const shown = (name: string) => Number(screen.getByTestId(name).textContent);

describe("useNow", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs one timer for every subscriber of an interval, and stops it with the last", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = render(
      <>
        <Clock name="a" />
        <Clock name="b" />
      </>,
    );
    expect(setInterval).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(1_000));
    expect(shown("a")).toBe(1_001_000);
    expect(shown("b")).toBe(1_001_000);
    unmount();
    expect(clearInterval).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads the time from the clock it is given — the server's, on the live path", () => {
    const serverNow = () => Date.now() + 3_600_000;
    render(<Clock name="server" read={serverNow} />);
    expect(shown("server")).toBe(4_600_000);
    act(() => void vi.advanceTimersByTime(2_000));
    expect(shown("server")).toBe(4_602_000);
  });

  it("gives each subscriber of a shared timer its own clock", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    render(
      <>
        <Clock name="browser" />
        <Clock name="server" read={() => Date.now() + 3_600_000} />
      </>,
    );
    expect(setInterval).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(1_000));
    expect(shown("browser")).toBe(1_001_000);
    expect(shown("server")).toBe(4_601_000);
  });

  it("reads a new clock at once, not a tick later", () => {
    const { rerender } = render(<Clock name="c" read={() => 1} />);
    expect(shown("c")).toBe(1);
    rerender(<Clock name="c" read={() => 2} />);
    expect(shown("c")).toBe(2);
  });
});
