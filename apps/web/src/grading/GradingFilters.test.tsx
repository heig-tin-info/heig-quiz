import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { GradingFilters } from "./GradingFilters";
import { ALL_PARTS_SHOWN } from "./parts";
import { ANY } from "./useGradingTraversal";

/*
 * Issue #98: the two selects of the filter row say what they filter, and
 * each choice is explained in words a screen reader hears too — not a
 * placeholder option and a hover bubble.
 */

function draw(source: "auto" | "llm" | "manual" | typeof ANY, confidence: "low" | typeof ANY) {
  renderWithProviders(
    <GradingFilters
      order="question"
      onOrder={vi.fn()}
      stateFilter="all"
      onStateFilter={vi.fn()}
      source={source}
      onSource={vi.fn()}
      confidence={confidence}
      onConfidence={vi.fn()}
      showNames={false}
      onShowNames={vi.fn()}
      parts={ALL_PARTS_SHOWN}
      onParts={vi.fn()}
    />,
  );
}

describe("GradingFilters", () => {
  it("labels both selects and names the sources plainly", () => {
    draw(ANY, ANY);
    const source = screen.getByLabelText("Graded by");
    expect(source.tagName).toBe("SELECT");
    expect(screen.getByLabelText("Confidence").tagName).toBe("SELECT");
    expect(screen.getByRole("option", { name: "Automatic (rules)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "AI model" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Teacher" })).toBeInTheDocument();
    expect(source).toHaveAccessibleDescription(/who proposed the grade/);
  });

  it("explains the chosen source and confidence on a visible line", () => {
    draw("llm", "low");
    expect(screen.getByLabelText("Graded by")).toHaveAccessibleDescription(/language model/);
    expect(screen.getByLabelText("Confidence")).toHaveAccessibleDescription(/unsure/);
    expect(screen.getByText(/language model/)).toBeVisible();
  });
});
