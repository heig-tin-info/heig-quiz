import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { answeredCount, CorrectionCount, ExpectedAnswers, KeyFigure, KeyFrame, KeyHatch } from "./correction.js";
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

describe("KeyFigure", () => {
  it("names the drawing it holds", () => {
    render(
      <KeyFigure density="wall" caption="Reference diagram">
        <svg role="img" aria-label="the drawing" />
      </KeyFigure>,
    );
    const figure = screen.getByRole("figure");
    expect(figure.querySelector("figcaption")!.textContent).toBe("Reference diagram");
    expect(screen.getByRole("img", { name: "the drawing" }).parentElement).toBe(figure);
  });
});

describe("KeyHatch", () => {
  it("is an empty block, hidden from assistive technology", () => {
    const { container } = render(<KeyHatch className="h-40" />);
    const block = container.firstElementChild!;
    expect(block.getAttribute("aria-hidden")).toBe("true");
    expect(block.textContent).toBe("");
  });
});

describe("KeyFrame", () => {
  const drawing = (shown: string, height: number) => `${shown} at ${height}`;

  it("keeps one element through the reveal, hidden and empty while there is nothing to show", () => {
    const { container, rerender } = render(
      <KeyFrame density="wall" shown={null} revealed={false}>
        {drawing}
      </KeyFrame>,
    );
    const frame = container.firstElementChild!;
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.textContent).toBe("");

    rerender(
      <KeyFrame density="wall" shown="the key" revealed framed={false}>
        {drawing}
      </KeyFrame>,
    );
    expect(container.firstElementChild).toBe(frame);
    expect(frame.hasAttribute("aria-hidden")).toBe(false);
    // Where nothing lays out, the page's height inside its padding.
    expect(frame.textContent).toBe("the key at 286");
  });

  it("draws at the height it measures, and stops measuring once gone", () => {
    let report: ResizeObserverCallback = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          report = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const { container, unmount } = render(
      <KeyFrame density="page" shown="the start" revealed={false}>
        {drawing}
      </KeyFrame>,
    );
    act(() => report([{ contentRect: { height: 471.6 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(container.textContent).toBe("the start at 471");
    unmount();
    expect(disconnect).toHaveBeenCalled();
    vi.unstubAllGlobals();
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
