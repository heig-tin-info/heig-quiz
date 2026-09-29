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
const STATS = { n: 24, p: 0.73, since: null, time: null, discrimination: null };
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

  it("shows the discrimination to two decimals, its reading and what it rests on", () => {
    mockFetch({});
    renderWithProviders(
      <QuestionStatsSheet
        poolId="p1"
        row={ROW}
        stats={{ ...STATS, discrimination: { r: 0.4, evaluations: 2, n: 21 } }}
        canReset
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("0.40")).toBeInTheDocument();
    expect(screen.getByText("Good")).toBeInTheDocument();
    expect(screen.getByText("Over 2 exams, 21 attempts")).toBeInTheDocument();
    expect(screen.getByText(/did well on the rest of the exam.*good from 0\.3, weak below 0\.2\./)).toBeInTheDocument();
    expect(screen.queryByText(/stronger students do worse/)).not.toBeInTheDocument();
  });

  it("flags an inverse question", () => {
    mockFetch({});
    renderWithProviders(
      <QuestionStatsSheet
        poolId="p1"
        row={ROW}
        stats={{ ...STATS, discrimination: { r: -0.18, evaluations: 1, n: 12 } }}
        canReset
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("-0.18")).toBeInTheDocument();
    expect(screen.getByText("Inverse")).toBeInTheDocument();
    expect(screen.getByText("Over one exam, 12 attempts")).toBeInTheDocument();
    expect(screen.getByText(/stronger students do worse/)).toBeInTheDocument();
  });

  it("writes the decimals of the index and its bands with a comma in French", async () => {
    mockFetch({});
    renderWithProviders(
      <QuestionStatsSheet
        poolId="p1"
        row={ROW}
        stats={{ ...STATS, discrimination: { r: 0.25, evaluations: 3, n: 30 } }}
        canReset
        onClose={vi.fn()}
      />,
      { locale: "fr" },
    );
    expect(await screen.findByText("0,25")).toBeInTheDocument();
    expect(screen.getByText("Moyen")).toBeInTheDocument();
    expect(screen.getByText(/bon dès 0,3, faible sous 0,2\./)).toBeInTheDocument();
  });

  it("says when the discrimination will show", () => {
    mockFetch({});
    renderWithProviders(<QuestionStatsSheet poolId="p1" row={ROW} stats={STATS} canReset onClose={vi.fn()} />);
    expect(
      screen.getByText("The discrimination shows once an exam with at least 5 other questions has 10 attempts graded in full."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Discrimination index")).not.toBeInTheDocument();
  });

  const DISTRACTORS = {
    n: 12,
    multiple: false,
    options: [
      { text: "NULL", correct: false, share: 50 },
      { text: "An indeterminate value", correct: true, share: 33 },
      { text: "Zero", correct: false, share: 8 },
    ],
    none: 8,
  };

  it("shows each choice's share, the key flagged in words, and the answers that picked nothing", () => {
    mockFetch({});
    renderWithProviders(
      <QuestionStatsSheet poolId="p1" row={ROW} stats={{ ...STATS, distractors: DISTRACTORS }} canReset onClose={vi.fn()} />,
    );
    expect(screen.getByText("Choices picked")).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "ANULL50%",
      "BAn indeterminate valueCorrect33%",
      "CZero8%",
      "No answer8%",
    ]);
    expect(screen.getByText("Share of 12 answers, on the versions whose choices are these ones.")).toBeInTheDocument();
    expect(screen.getByText(/A wrong choice nobody picks distracts no one/)).toBeInTheDocument();
    expect(screen.queryByText(/add up to more than 100%/)).not.toBeInTheDocument();
  });

  it("says a multiple-choice question's shares add up past 100", () => {
    mockFetch({});
    renderWithProviders(
      <QuestionStatsSheet
        poolId="p1"
        row={ROW}
        stats={{ ...STATS, distractors: { ...DISTRACTORS, multiple: true } }}
        canReset
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "Share of 12 answers, on the versions whose choices are these ones. Several choices may be ticked, so the shares add up to more than 100%.",
      ),
    ).toBeInTheDocument();
  });

  it("says when the choices will show, and draws no block for a type without them", () => {
    mockFetch({});
    const { unmount } = renderWithProviders(
      <QuestionStatsSheet poolId="p1" row={ROW} stats={{ ...STATS, distractors: null }} canReset onClose={vi.fn()} />,
    );
    expect(
      screen.getByText("The choices picked show from 10 answers given to versions with the current choices."),
    ).toBeInTheDocument();
    unmount();
    renderWithProviders(<QuestionStatsSheet poolId="p1" row={ROW} stats={STATS} canReset onClose={vi.fn()} />);
    expect(screen.queryByText("Choices picked")).not.toBeInTheDocument();
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
