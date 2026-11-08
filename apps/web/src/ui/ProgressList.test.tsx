import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { ProgressList, type Segment } from ".";

describe("ProgressList", () => {
  const segments: Segment[] = [
    { id: "q1", mark: "answered" },
    { id: "q2", mark: "skipped", flagged: true },
    { id: "q3", mark: "unanswered", current: true },
    { id: "q4", mark: "unanswered", locked: true },
  ];

  it("names each row like the strip, and gives the current one the only tab stop", () => {
    renderWithProviders(<ProgressList segments={segments} label="Progress" onSelect={() => {}} />);
    expect(screen.getByRole("navigation", { name: "Progress" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Question 2, left unanswered, flagged for review" }),
    ).toBeInTheDocument();
    const current = screen.getByRole("button", { name: "Question 3, not answered, current" });
    expect(current).toHaveAttribute("aria-current", "true");
    expect(screen.getAllByRole("button").filter((b) => b.tabIndex === 0)).toEqual([current]);
  });

  it("draws the path covered down the list", () => {
    const { container } = renderWithProviders(
      <ProgressList segments={segments} label="Progress" onSelect={() => {}} />,
    );
    const links = Array.from(container.querySelectorAll("[data-part=link]"));
    expect(links.map((l) => l.classList.contains("bg-fg"))).toEqual([true, false, false]);
  });

  it("roves down and up a row, stopping at the ends, and still steps on ←/→", async () => {
    renderWithProviders(<ProgressList segments={segments} label="Progress" onSelect={() => {}} />);
    const at = (n: number) => screen.getByRole("button", { name: new RegExp(`^Question ${n},`) });
    at(3).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(at(4)).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(at(4)).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(at(3)).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(at(4)).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(at(1)).toHaveFocus();
  });

  it("hands the caller the id it clicked", async () => {
    const onSelect = vi.fn();
    renderWithProviders(<ProgressList segments={segments} label="Progress" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: /^Question 2,/ }));
    expect(onSelect).toHaveBeenCalledWith("q2");
  });
});
