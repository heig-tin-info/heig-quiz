import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttemptView } from "@quiz/contracts";

import { mockFetch, renderWithProviders } from "../test/render";
import { STATION_END_MS } from "../kiosk/navigation";
import { PlayerEnd } from "./PlayerEnd";

const view = {
  attempt: { id: "a1", preview: false },
  evaluation: { title: "Quiz 3 — Pointeurs", mode: "exam", settings: {} },
} as unknown as AttemptView;

afterEach(() => vi.useRealTimers());

describe("the end of a sitting on a kiosk station (ADR-051 §7)", () => {
  it("shows the closed screen from what the page holds, then goes back to the station's screen", async () => {
    vi.useFakeTimers();
    const { calls } = mockFetch({});
    const onHome = vi.fn();
    renderWithProviders(<PlayerEnd reason="submitted" initial={view} onHome={onHome} onResults={vi.fn()} station />);
    expect(screen.getByRole("heading", { name: "Handed in" })).toBeVisible();
    expect(screen.getByText("This station goes back to its start screen in a few seconds.")).toBeVisible();
    // Its session is gone: nothing more is asked of the server, no results link.
    expect(screen.queryByRole("button", { name: /results/i })).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(STATION_END_MS - 1));
    expect(onHome).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(onHome).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(0);
  });
});
