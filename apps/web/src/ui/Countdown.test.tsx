import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { Countdown } from ".";

/*
 * The five live primitives (PLAN-MVP §6.4). What is asserted of each is the
 * same triple: it renders, a screen reader is told the state in words, and
 * the state variants differ by more than their tint.
 */
describe("Countdown", () => {
  const now = 1_700_000_000_000;

  it("shows the time left and names it for a reader", () => {
    renderWithProviders(<Countdown deadlineAt={now + 872_000} now={now} />);
    const timer = screen.getByRole("timer");
    expect(timer).toHaveTextContent("14:32");
    expect(timer).toHaveAccessibleName("14:32 remaining");
  });

  it("stays neutral above the threshold and turns warning under it", () => {
    const { rerender } = renderWithProviders(
      <Countdown deadlineAt={now + 600_000} now={now} warnUnderS={300} />,
    );
    expect(screen.getByRole("timer")).toHaveClass("text-fg");
    rerender(<Countdown deadlineAt={now + 240_000} now={now} warnUnderS={300} />);
    expect(screen.getByRole("timer")).toHaveClass("text-warning");
  });

  it("turns danger under a minute even when the threshold is lower", () => {
    renderWithProviders(<Countdown deadlineAt={now + 30_000} now={now} warnUnderS={20} />);
    expect(screen.getByRole("timer")).toHaveClass("text-danger");
  });

  it("announces the phase once when it is crossed, not every tick", async () => {
    const live = () => document.querySelector('[aria-live="polite"]')!;
    const { rerender } = renderWithProviders(
      <Countdown deadlineAt={now + 600_000} now={now} warnUnderS={300} />,
    );
    expect(live()).toHaveTextContent("");
    rerender(<Countdown deadlineAt={now + 240_000} now={now} warnUnderS={300} />);
    await waitFor(() => expect(live()).toHaveTextContent("4:00 remaining."));
    // One more second inside the same phase must not re-announce.
    rerender(<Countdown deadlineAt={now + 239_000} now={now} warnUnderS={300} />);
    expect(live()).toHaveTextContent("4:00 remaining.");
  });

  it("says the time is up rather than counting into the negative", () => {
    renderWithProviders(<Countdown deadlineAt={now - 5_000} now={now} />);
    const timer = screen.getByRole("timer");
    expect(timer).toHaveTextContent("0:00");
    expect(timer).toHaveAccessibleName("Time is up.");
  });

  it("speaks French when the locale does (N-I18N-01)", () => {
    renderWithProviders(<Countdown deadlineAt={now + 60_001} now={now} />, { locale: "fr" });
    expect(screen.getByRole("timer")).toHaveAccessibleName("il reste 1:01");
  });

  /*
   * W16: a paused evaluation is not spending its window. The digits froze at
   * the moment of the pause and say so; the server's clock keeps ticking
   * underneath, which is exactly what must not show.
   */
  it("freezes while paused and says it is paused", () => {
    const { rerender } = renderWithProviders(
      <Countdown deadlineAt={now + 600_000} now={now} paused={false} />,
    );
    expect(screen.getByRole("timer")).toHaveTextContent("10:00");

    rerender(<Countdown deadlineAt={now + 600_000} now={now} paused />);
    rerender(<Countdown deadlineAt={now + 600_000} now={now + 7_000} paused />);
    const timer = screen.getByRole("timer");
    expect(timer).toHaveTextContent("10:00");
    expect(timer).toHaveTextContent("paused");
    expect(timer).toHaveAccessibleName("10:00 remaining, paused");
    // Frozen, so it is not urgent either: no warning or danger tone.
    expect(timer).toHaveClass("text-fg-muted");

    // Resuming picks the real clock back up.
    rerender(<Countdown deadlineAt={now + 600_000} now={now + 7_000} paused={false} />);
    expect(screen.getByRole("timer")).toHaveTextContent("9:53");
  });
});
