import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { ProgressSegments, type Segment } from ".";

describe("ProgressSegments", () => {
  const segments: Segment[] = [
    { id: "q1", mark: "answered" },
    { id: "q2", mark: "skipped", flagged: true },
    { id: "q3", mark: "unanswered", current: true },
    { id: "q4", mark: "unanswered", locked: true },
  ];

  it("names every segment with its number and its facts in words (issue #89)", () => {
    renderWithProviders(<ProgressSegments segments={segments} label="Progress" onSelect={() => {}} />);
    expect(screen.getByRole("navigation", { name: "Progress" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Question 1, answered" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Question 2, left unanswered, flagged for review" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Question 4, not answered, closed" })).toBeInTheDocument();
  });

  it("marks the current one and gives it the only tab stop", () => {
    renderWithProviders(<ProgressSegments segments={segments} label="Progress" onSelect={() => {}} />);
    const current = screen.getByRole("button", { name: "Question 3, not answered, current" });
    expect(current).toHaveAttribute("aria-current", "true");
    const stops = screen.getAllByRole("button").filter((b) => b.tabIndex === 0);
    expect(stops).toEqual([current]);
  });

  it("draws each mark as a SHAPE with a symbol, not only a tint (colour-blind safe)", () => {
    const { container } = renderWithProviders(
      <ProgressSegments segments={segments} label="Progress" onSelect={() => {}} />,
    );
    const bars = Array.from(container.querySelectorAll("button > span:first-child"));
    // Answered: solid, with a check inside.
    expect(bars[0]).toHaveClass("bg-fg");
    expect(bars[0]!.querySelector("svg")).not.toBeNull();
    // Left unanswered: a dashed outline, with a dash inside.
    expect(bars[1]).toHaveClass("border-dashed");
    expect(bars[1]!.querySelector("svg")).not.toBeNull();
    // Nothing yet: hollow, no symbol.
    expect(bars[2]).not.toHaveClass("bg-fg");
    expect(bars[2]!.querySelector("svg")).toBeNull();
    // The flag sits by the number, and only on the flagged one.
    const labels = Array.from(container.querySelectorAll("button > span:last-child"));
    expect(labels[1]!.querySelector("svg")).not.toBeNull();
    expect(labels[0]!.querySelector("svg")).toBeNull();
  });

  it("draws the path covered: a solid connector between two questions dealt with (issue #219)", () => {
    const { container } = renderWithProviders(
      <ProgressSegments segments={segments} label="Progress" onSelect={() => {}} />,
    );
    const links = Array.from(container.querySelectorAll("[data-part=link]"));
    // Three links for four questions; answered -> skipped is covered, the rest is not yet.
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.classList.contains("bg-fg"))).toEqual([true, false, false]);
  });

  it("moves with the arrows, wraps, and jumps with Home and End", async () => {
    renderWithProviders(<ProgressSegments segments={segments} label="Progress" onSelect={() => {}} />);
    const at = (n: number) => screen.getByRole("button", { name: new RegExp(`^Question ${n},`) });
    at(3).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(at(4)).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(at(1)).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(at(4)).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(at(1)).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(at(4)).toHaveFocus();
  });

  it("hands the caller the id and the index it clicked", async () => {
    const onSelect = vi.fn();
    renderWithProviders(<ProgressSegments segments={segments} label="Progress" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: /^Question 2,/ }));
    expect(onSelect).toHaveBeenCalledWith("q2", 1);
  });

  it("is a read-only indicator when navigation is locked", () => {
    renderWithProviders(<ProgressSegments segments={segments} label="Progress" />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });

  it("prints every number while the bars have the room for one", () => {
    const { container } = renderWithProviders(
      <ProgressSegments segments={segments} label="Progress" onSelect={() => {}} />,
    );
    const numbers = Array.from(container.querySelectorAll("button > span:last-child")).map(
      (s) => s.textContent,
    );
    expect(numbers).toEqual(["1", "2", "3", "4"]);
  });

  it("scrolls instead of overlapping once a dot no longer fits, and follows the current one (issue #223)", () => {
    // 358 px (a phone) over 40 segments is ~9 px each: under the 14 px a dot needs.
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(358);
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo;
    try {
      const many = (current: number): Segment[] =>
        Array.from({ length: 40 }, (_, i) => ({ id: `q${i + 1}`, mark: "unanswered", current: i === current }));
      const { container, rerender } = renderWithProviders(
        <ProgressSegments segments={many(6)} label="Progress" onSelect={() => {}} />,
      );
      expect(screen.getByRole("navigation", { name: "Progress" })).toHaveClass("overflow-x-auto");
      // Every question is back in a full slot, with its number.
      const numbers = Array.from(container.querySelectorAll("button > span:last-child")).filter(
        (s) => s.textContent,
      );
      expect(numbers).toHaveLength(40);
      const calls = scrollTo.mock.calls.length;
      expect(calls).toBeGreaterThan(0);
      // Moving on scrolls again, to keep the new current question in view.
      rerender(<ProgressSegments segments={many(30)} label="Progress" onSelect={() => {}} />);
      expect(scrollTo.mock.calls.length).toBeGreaterThan(calls);
    } finally {
      width.mockRestore();
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it("thins the numbers down to anchors when the segments get too narrow", () => {
    // jsdom runs no layout, so the strip is asked for its width directly.
    // 800 px over 40 segments is ~16 px each: numbers every fifth.
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    try {
      const many: Segment[] = Array.from({ length: 40 }, (_, i) => ({
        id: `q${i + 1}`,
        mark: i < 6 ? "answered" : "unanswered",
        current: i === 6,
        flagged: i === 30,
      }));
      const { container } = renderWithProviders(
        <ProgressSegments segments={many} label="Progress" onSelect={() => {}} />,
      );
      const numbers = Array.from(container.querySelectorAll("button > span:last-child"))
        .map((s) => s.textContent)
        .filter(Boolean);
      // First, last, the current one, and every fifth in between.
      expect(numbers).toEqual(["1", "5", "7", "10", "15", "20", "25", "30", "35", "40"]);
      // The strip still names all forty of them for a screen reader.
      expect(screen.getAllByRole("button")).toHaveLength(40);
      expect(screen.getByRole("button", { name: "Question 23, not answered" })).toBeInTheDocument();
      // A flag is never thinned out with the numbers.
      expect(
        Array.from(container.querySelectorAll("button > span:last-child"))[30]!.querySelector("svg"),
      ).not.toBeNull();
    } finally {
      width.mockRestore();
    }
  });
});
