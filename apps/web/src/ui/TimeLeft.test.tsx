import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { TimeLeft, timeLeft } from ".";

/*
 * The time left on a deadline, compact, in a state badge (ADR-104). Pure
 * like `relativeTime`: the clock and the words come in.
 */
describe("timeLeft", () => {
  const now = Date.parse("2026-09-21T12:00:00.000Z");
  const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const WORDS: Record<string, string> = {
    "time.left.days": "{n} d",
    "time.left.dayHour": "{d} d {h} h",
    "time.left.hours": "{n} h",
    "time.left.hourMin": "{h} h {m} min",
    "time.left.minutes": "{n} min",
    "time.left.minSec": "{m} min {s} s",
    "time.left.seconds": "{n} s",
  };
  const en = ((key: string, vars?: Record<string, string | number>) =>
    WORDS[key]!.replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k]))) as Parameters<typeof timeLeft>[2];
  const S = 1_000;
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  it("says days and hours from a day, the hours left out when zero", () => {
    expect(timeLeft(at(2 * DAY + 5 * HOUR + 59 * MIN), now, en)).toBe("2 d 5 h");
    expect(timeLeft(at(4 * DAY + 30 * MIN), now, en)).toBe("4 d");
    expect(timeLeft(at(DAY), now, en)).toBe("1 d");
  });

  it("says hours and minutes under a day, minutes alone under an hour", () => {
    expect(timeLeft(at(DAY - S), now, en)).toBe("23 h 59 min");
    expect(timeLeft(at(HOUR + 40 * MIN + 59 * S), now, en)).toBe("1 h 40 min");
    expect(timeLeft(at(3 * HOUR + 30 * S), now, en)).toBe("3 h");
    expect(timeLeft(at(HOUR), now, en)).toBe("1 h");
    expect(timeLeft(at(HOUR - S), now, en)).toBe("59 min");
    expect(timeLeft(at(35 * MIN + 59 * S), now, en)).toBe("35 min");
    expect(timeLeft(at(10 * MIN), now, en)).toBe("10 min");
  });

  it("counts the seconds in the last ten minutes", () => {
    expect(timeLeft(at(10 * MIN - S), now, en)).toBe("9 min 59 s");
    expect(timeLeft(at(9 * MIN + 32 * S + 999), now, en)).toBe("9 min 32 s");
    expect(timeLeft(at(5 * MIN), now, en)).toBe("5 min");
    expect(timeLeft(at(MIN), now, en)).toBe("1 min");
    expect(timeLeft(at(59 * S), now, en)).toBe("59 s");
    expect(timeLeft(at(999), now, en)).toBe("0 s");
  });

  it("never goes negative: a deadline in its grace reads 0 s until the state catches up", () => {
    expect(timeLeft(at(0), now, en)).toBe("0 s");
    expect(timeLeft(at(-3_000), now, en)).toBe("0 s");
    expect(timeLeft(at(-2 * DAY), now, en)).toBe("0 s");
  });
});

describe("TimeLeft", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the figure beside its glyph, says what it is to a screen reader, and keeps the stamp", () => {
    const iso = new Date(Date.now() + 3 * 3_600_000 + 30_000).toISOString();
    renderWithProviders(<TimeLeft iso={iso} />);
    const figure = screen.getByText("3 h");
    expect(figure).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("closes in 3 h")).toHaveClass("sr-only");
    const time = figure.closest("time")!;
    expect(time).toHaveAttribute("datetime", iso);
    expect(time).toHaveAttribute("tabindex", "0");
    expect(time.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("speaks French when the locale does", () => {
    renderWithProviders(<TimeLeft iso={new Date(Date.now() + 2 * 86_400_000 + 60_000).toISOString()} />, { locale: "fr" });
    expect(screen.getByText("2 j")).toBeInTheDocument();
    expect(screen.getByText("ferme dans 2 j")).toBeInTheDocument();
  });

  it("writes hours and padded minutes in French", () => {
    renderWithProviders(<TimeLeft iso={new Date(Date.now() + 3_600_000 + 5 * 60_000 + 30_000).toISOString()} />, { locale: "fr" });
    expect(screen.getByText("1 h 05")).toBeInTheDocument();
  });

  it("ticks every second in the last ten minutes, and to the minute before", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-21T12:00:00.000Z"));
    renderWithProviders(<TimeLeft iso="2026-09-21T12:10:30.000Z" />);
    expect(screen.getByText("10 min")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("9 min 30 s")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText("9 min 29 s")).toBeInTheDocument();
  });

  it("starts counting seconds exactly at the ten-minute mark, not at the next minute tick", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-21T12:00:00.000Z"));
    renderWithProviders(<TimeLeft iso="2026-09-21T12:10:30.000Z" />);
    expect(screen.getByText("10 min")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(screen.getByText("9 min 59 s")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText("9 min 58 s")).toBeInTheDocument();
  });

  it("goes back to the minute timer once the deadline passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-21T12:00:00.000Z"));
    renderWithProviders(<TimeLeft iso="2026-09-21T12:00:05.000Z" />);
    expect(screen.getByText("5 s")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(screen.getByText("0 s")).toBeInTheDocument();
    // The minute interval alone, the second one released.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("arms no switch for a deadline beyond setTimeout's range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-21T12:00:00.000Z"));
    renderWithProviders(<TimeLeft iso="2026-10-21T12:00:00.000Z" />);
    expect(screen.getByText("30 d")).toBeInTheDocument();
    // Only the shared minute timer: an overflowing setTimeout would fire at
    // once and put the badge on the second timer.
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(vi.getTimerCount()).toBe(1);
  });
});
