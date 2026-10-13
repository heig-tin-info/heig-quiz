import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { answeredCount, CorrectionCount, ExpectedAnswers } from "./correction.js";
import { keyHostProps } from "./testing.js";

describe("answeredCount", () => {
  it("sums the four outcomes", () => {
    expect(answeredCount({ outcomes: { correct: 3, partial: 2, wrong: 1, blank: 4 } })).toBe(10);
  });
});

describe("CorrectionCount", () => {
  it("draws the figure at the density's size", () => {
    render(<CorrectionCount density="wall">7</CorrectionCount>);
    expect(screen.getByText("7").className).toContain("font-mono");
  });
});

describe("ExpectedAnswers", () => {
  const rows = <p>groups</p>;
  const base = { label: "Expected answer", density: "page" as const, rows };

  it("names the answers once revealed, above the groups", () => {
    render(<ExpectedAnswers {...base} answers={["3", "3.0"]} revealed grouped />);
    expect(screen.getByText("3 · 3.0")).toBeTruthy();
    expect(screen.getByText("groups")).toBeTruthy();
  });

  it("keeps the answers back while hidden", () => {
    render(<ExpectedAnswers {...base} answers={["42"]} revealed={false} grouped />);
    expect(screen.queryByText(/42/)).toBeNull();
    expect(screen.getByText("groups")).toBeTruthy();
  });

  it("with no answer named, draws the groups alone, or nothing without any", () => {
    const { container, rerender } = render(<ExpectedAnswers {...base} answers={[]} revealed grouped />);
    expect(screen.getByText("groups")).toBeTruthy();
    rerender(<ExpectedAnswers {...base} answers={[]} revealed grouped={false} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("keyHostProps", () => {
  it("lends a bar that names its labelled non-empty parts, and is mute otherwise", () => {
    const { Bar, stats } = keyHostProps({ outcomes: { correct: 1, partial: 0, wrong: 0, blank: 0 } });
    expect(stats.outcomes.correct).toBe(1);
    const { container, rerender } = render(
      <Bar
        parts={[
          { tone: "success", value: 2, label: "correct" },
          { tone: "danger", value: 0, label: "wrong" },
        ]}
      />,
    );
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("correct: 2");
    rerender(<Bar parts={[{ tone: "muted", value: 2 }]} />);
    expect(container.querySelector("[aria-hidden]")).not.toBeNull();
  });
});
