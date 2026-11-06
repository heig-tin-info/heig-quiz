import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { SebUnlock } from "./SebUnlock";

describe("the SEB unlock password on the live screen (ADR-027, 2026-11-06)", () => {
  it("is hidden by default, revealed on click, and hidden again on a second click", async () => {
    renderWithProviders(<SebUnlock password="cde234" />);
    const toggle = screen.getByRole("button", { name: /^SEB password/ });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("cde234")).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("cde234")).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.queryByText("cde234")).not.toBeInTheDocument();
  });

  it("is absent when the evaluation does not trust SEB", () => {
    renderWithProviders(<SebUnlock password={null} />);
    expect(screen.queryByRole("button", { name: /^SEB password/ })).not.toBeInTheDocument();
  });
});
