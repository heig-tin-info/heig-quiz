import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiAgreement, ContestationTally } from "@quiz/contracts";

import { renderWithProviders } from "../test/render";
import { AgreementBadge, ContestationsBadge, ContestedBadge, GradingFiguresStats } from "./GradingFigures";
import { QuestionBar } from "./QuestionBar";
import type { GradingItem } from "./useGradingData";

/*
 * The agreement figures (ADR-139 §15): quiet counts with their total, the
 * detail in the tooltip or under the figure; nothing at all where the
 * server sent `null`.
 */

const AGREEMENT: AiAgreement = {
  compared: 15,
  unchanged: 12,
  changed: 3,
  meanAbsDelta: 0.75,
  byConfidence: {
    high: { compared: 9, unchanged: 9, changed: 0, meanAbsDelta: null },
    medium: { compared: 5, unchanged: 3, changed: 2, meanAbsDelta: 0.5 },
    low: null,
  },
};

const CONTESTED: ContestationTally = {
  filed: 3,
  accepted: 1,
  graded: 40,
  open: 1,
  refused: 1,
  bySource: { auto: { filed: 0, accepted: 0 }, llm: { filed: 2, accepted: 1 }, manual: { filed: 1, accepted: 0 } },
};

const ITEM: GradingItem = {
  id: "i0",
  position: 0,
  internalName: "essay-1",
  type: "rich",
  points: 3,
  counting: "normal",
  minPoints: 0,
  questionId: "q0",
  canEdit: false,
  stale: false,
};

const bar = (agreement: AiAgreement | null | undefined, contested = 0) =>
  renderWithProviders(
    <QuestionBar
      items={[ITEM]}
      index={0}
      states={new Map([["i0", { total: 15, validated: 15, contested }]])}
      agreement={agreement}
      onJump={() => {}}
      onOpenStatement={() => {}}
    />,
  );

/** The tooltip of the element whose text is `text`, once the hover delay has passed. */
function tipOf(text: string): string | null {
  fireEvent.mouseEnter(screen.getByText(text).closest("span")!.parentElement!);
  act(() => {
    vi.advanceTimersByTime(200);
  });
  return document.querySelector(".tip-bubble")?.textContent ?? null;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the agreement figures", () => {
  it("put the AI's agreement on the question bar, its detail in the tooltip", () => {
    vi.useFakeTimers();
    bar(AGREEMENT);
    expect(tipOf("AI: 12 of 15 unchanged")).toBe(
      "Mean difference when changed: 0.75 pts · By confidence: High 9/9, Medium 3/5",
    );
  });

  it("leave the mean difference out when nothing changed, and draw nothing with nothing compared", () => {
    vi.useFakeTimers();
    const { unmount } = renderWithProviders(<AgreementBadge agreement={{ ...AGREEMENT, changed: 0, meanAbsDelta: null }} />);
    expect(tipOf("AI: 12 of 15 unchanged")).toBe("By confidence: High 9/9, Medium 3/5");
    unmount();
    bar(null);
    expect(screen.queryByText(/unchanged/)).toBeNull();
    bar(undefined);
    expect(screen.queryByText(/unchanged/)).toBeNull();
  });

  it("count the open contestations on the bar, one or many, and nothing at none", () => {
    const { unmount } = bar(null, 1);
    expect(screen.getByText("1 contested")).toBeInTheDocument();
    unmount();
    renderWithProviders(<ContestedBadge n={0} />);
    expect(screen.queryByText(/contested/)).toBeNull();
    renderWithProviders(<ContestedBadge n={4} />);
    expect(screen.getByText("4 contested")).toBeInTheDocument();
  });

  it("give a question's contestations their total, verdicts and sources in the tooltip", () => {
    vi.useFakeTimers();
    renderWithProviders(<ContestationsBadge tally={CONTESTED} />);
    expect(tipOf("3 contested")).toBe(
      "3 of 40 graded answers · Open 1, accepted 1, refused 1 · Contested grading: AI 2 (1 accepted), manual 1 (0 accepted)",
    );
  });

  it("draw nothing for a question nobody contested", () => {
    renderWithProviders(<ContestationsBadge tally={null} />);
    expect(screen.queryByText(/contested/)).toBeNull();
  });

  it("draw the evaluation's two figures with their totals and their detail", () => {
    renderWithProviders(<GradingFiguresStats figures={{ agreement: AGREEMENT, contestations: CONTESTED }} />);
    expect(screen.getByText("of 15 compared")).toBeInTheDocument();
    expect(screen.getByText("Mean difference when changed: 0.75 pts")).toBeInTheDocument();
    expect(screen.getByText("By confidence: High 9/9, Medium 3/5")).toBeInTheDocument();
    expect(screen.getByText("of 40 graded")).toBeInTheDocument();
    expect(screen.getByText("Contested grading: AI 2 (1 accepted), manual 1 (0 accepted)")).toBeInTheDocument();
  });

  it("draw one figure alone, a contestation whose grading is gone in no source", () => {
    const none = { filed: 0, accepted: 0 };
    renderWithProviders(
      <GradingFiguresStats figures={{ agreement: null, contestations: { ...CONTESTED, bySource: { auto: none, llm: none, manual: none } } }} />,
    );
    expect(screen.queryByText("AI proposals unchanged")).toBeNull();
    expect(screen.getByText("Open 1, accepted 1, refused 1")).toBeInTheDocument();
    expect(screen.queryByText(/Contested grading/)).toBeNull();
  });

  it("draw nothing when both are null", () => {
    renderWithProviders(<GradingFiguresStats figures={{ agreement: null, contestations: null }} />);
    expect(screen.queryByText("AI proposals unchanged")).toBeNull();
    expect(screen.queryByText("Contested answers")).toBeNull();
  });
});
