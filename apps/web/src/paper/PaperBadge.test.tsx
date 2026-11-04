import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { PaperBadge, SupersededBadge } from "./PaperBadge";

describe("PaperBadge", () => {
  it("marks a paper copy, and nothing else", () => {
    const { rerender } = renderWithProviders(<PaperBadge origin="paper" />);
    expect(screen.getByText("paper")).toBeInTheDocument();
    rerender(<PaperBadge origin="digital" />);
    expect(screen.queryByText("paper")).toBeNull();
  });

  it("marks an attempt a paper copy replaced", () => {
    renderWithProviders(<SupersededBadge supersededBy="cccccccc-0000-4000-8000-000000000001" />);
    expect(screen.getByText("replaced")).toBeInTheDocument();
  });
});
