import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { mockFetch, ok, renderWithProviders } from "../test/render";
import { QuestionStatsSheet } from "./QuestionStatsSheet";

/*
 * The statistics panel of one question (ADR-038): the two numbers, a signed
 * rate, since when, and the reset — confirmed, and only for whoever may write
 * the pool. And the time spent (ADR-039), or why it is not there yet.
 */

const ROW = { id: "q1", internalName: "ptr-arith-01" };
const STATS = { n: 24, p: 0.73, since: null, time: null };
const TIME = { n: 21, meanS: 95, medianS: 80, p25S: 52, p75S: 121 };

describe("QuestionStatsSheet", () => {
  it("shows the success rate and the number of answers", () => {
    mockFetch({});
    renderWithProviders(<QuestionStatsSheet poolId="p1" row={ROW} stats={STATS} canReset onClose={vi.fn()} />);
    expect(screen.getByText("73%")).toBeInTheDocument();
    expect(screen.getByText("24")).toBeInTheDocument();
    expect(screen.getByText("Since the question was first used")).toBeInTheDocument();
    expect(screen.queryByText(/Below zero/)).not.toBeInTheDocument();
  });

  it("keeps a negative rate signed, and says why", () => {
    mockFetch({});
    renderWithProviders(
      <QuestionStatsSheet poolId="p1" row={ROW} stats={{ ...STATS, n: 12, p: -0.08 }} canReset onClose={vi.fn()} />,
    );
    expect(screen.getByText("-8%")).toBeInTheDocument();
    expect(screen.getByText(/Below zero/)).toBeInTheDocument();
  });

  it("says since when after a reset", () => {
    mockFetch({});
    renderWithProviders(
      <QuestionStatsSheet
        poolId="p1"
        row={ROW}
        stats={{ ...STATS, since: "2026-09-01T08:00:00.000Z" }}
        canReset
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/^Since /)).toBeInTheDocument();
  });

  it("shows the time spent: the median with its middle half, the mean and the timed answers", () => {
    mockFetch({});
    renderWithProviders(
      <QuestionStatsSheet poolId="p1" row={ROW} stats={{ ...STATS, time: TIME }} canReset onClose={vi.fn()} />,
    );
    expect(screen.getByText("Time spent")).toBeInTheDocument();
    expect(screen.getByText("1 min 20 s")).toBeInTheDocument();
    expect(screen.getByText("Middle half: 52 s to 2 min 01 s")).toBeInTheDocument();
    expect(screen.getByText("1 min 35 s")).toBeInTheDocument();
    expect(screen.getByText("21")).toBeInTheDocument();
    expect(screen.getByText(/counts 10 minutes at most/)).toBeInTheDocument();
    expect(screen.queryByText(/The time shows from/)).not.toBeInTheDocument();
  });

  it("says in one line when there are too few timed answers", () => {
    mockFetch({});
    renderWithProviders(<QuestionStatsSheet poolId="p1" row={ROW} stats={STATS} canReset onClose={vi.fn()} />);
    expect(screen.getByText("The time shows from 10 timed exam answers.")).toBeInTheDocument();
    expect(screen.queryByText("Median time")).not.toBeInTheDocument();
  });

  it("offers no reset to a reader", () => {
    mockFetch({});
    renderWithProviders(<QuestionStatsSheet poolId="p1" row={ROW} stats={STATS} canReset={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Reset statistics/ })).not.toBeInTheDocument();
  });

  it("resets after a confirmation, then closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { calls } = mockFetch({
      "POST /app/api/questions/q1/stats/reset": ok({ since: "2026-09-29T08:00:00.000Z" }),
    });
    renderWithProviders(<QuestionStatsSheet poolId="p1" row={ROW} stats={STATS} canReset onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: /Reset statistics/ }));
    const confirm = await screen.findByRole("dialog", { name: "Reset the statistics of ptr-arith-01?" });
    await user.click(within(confirm).getByRole("button", { name: "Reset" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(await screen.findByText("Statistics reset.")).toBeInTheDocument();
  });
});
