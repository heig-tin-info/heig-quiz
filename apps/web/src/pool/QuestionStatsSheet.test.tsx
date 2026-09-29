import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { mockFetch, ok, renderWithProviders } from "../test/render";
import { QuestionStatsSheet } from "./QuestionStatsSheet";

/*
 * The statistics panel of one question (ADR-038): the two numbers, a signed
 * rate, the state below the threshold, and the reset — confirmed, and only
 * for whoever may write the pool.
 */

const ROW = { id: "q1", internalName: "ptr-arith-01" };

describe("QuestionStatsSheet", () => {
  it("shows the success rate and the number of answers", async () => {
    mockFetch({ "GET /app/api/questions/q1/stats": ok({ since: null, stats: { n: 24, p: 0.73 } }) });
    renderWithProviders(<QuestionStatsSheet poolId="p1" row={ROW} canReset onClose={vi.fn()} />);
    expect(await screen.findByText("73%")).toBeInTheDocument();
    expect(screen.getByText("24")).toBeInTheDocument();
    expect(await screen.findByText("Since the question was first used")).toBeInTheDocument();
    expect(screen.queryByText(/Below zero/)).not.toBeInTheDocument();
  });

  it("keeps a negative rate signed, and says why", async () => {
    mockFetch({ "GET /app/api/questions/q1/stats": ok({ since: null, stats: { n: 12, p: -0.08 } }) });
    renderWithProviders(<QuestionStatsSheet poolId="p1" row={ROW} canReset onClose={vi.fn()} />);
    expect(await screen.findByText("-8%")).toBeInTheDocument();
    expect(screen.getByText(/Below zero/)).toBeInTheDocument();
  });

  it("says when there are not enough answers since the last reset", async () => {
    mockFetch({
      "GET /app/api/questions/q1/stats": ok({ since: "2026-09-01T08:00:00.000Z", stats: null }),
    });
    renderWithProviders(<QuestionStatsSheet poolId="p1" row={ROW} canReset onClose={vi.fn()} />);
    expect(await screen.findByText("Fewer than 10 answers since the last reset.")).toBeInTheDocument();
    expect(screen.getByText(/^Since /)).toBeInTheDocument();
  });

  it("offers no reset to a reader", async () => {
    mockFetch({ "GET /app/api/questions/q1/stats": ok({ since: null, stats: { n: 24, p: 0.73 } }) });
    renderWithProviders(<QuestionStatsSheet poolId="p1" row={ROW} canReset={false} onClose={vi.fn()} />);
    await screen.findByText("73%");
    expect(screen.queryByRole("button", { name: /Reset statistics/ })).not.toBeInTheDocument();
  });

  it("resets after a confirmation, then reads the statistics again", async () => {
    const user = userEvent.setup();
    let reset = false;
    const { calls } = mockFetch({
      "GET /app/api/questions/q1/stats": () =>
        ok(
          reset
            ? { since: "2026-09-29T08:00:00.000Z", stats: null }
            : { since: null, stats: { n: 24, p: 0.73 } },
        ),
      "POST /app/api/questions/q1/stats/reset": () => {
        reset = true;
        return ok({ since: "2026-09-29T08:00:00.000Z" });
      },
    });
    renderWithProviders(<QuestionStatsSheet poolId="p1" row={ROW} canReset onClose={vi.fn()} />);
    await screen.findByText("73%");
    await user.click(screen.getByRole("button", { name: /Reset statistics/ }));
    const confirm = await screen.findByRole("dialog", { name: "Reset the statistics of ptr-arith-01?" });
    await user.click(within(confirm).getByRole("button", { name: "Reset" }));

    expect(await screen.findByText("Fewer than 10 answers since the last reset.")).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(await screen.findByText("Statistics reset.")).toBeInTheDocument();
  });
});
