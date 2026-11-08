import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { ToggleChip } from ".";

describe("ToggleChip", () => {
  it("is a pressed-or-not button, and says which it is", async () => {
    const onToggle = vi.fn();
    renderWithProviders(
      <>
        <ToggleChip label="Multiple choice" pressed={false} onToggle={onToggle} />
        <ToggleChip label="Short answer" pressed onToggle={vi.fn()} />
      </>,
    );
    const off = screen.getByRole("button", { name: "Multiple choice" });
    expect(off).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Short answer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(off);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("takes a name when the visible label is a bare number", () => {
    renderWithProviders(
      <ToggleChip label={3} aria-label="Difficulty 3 of 5" pressed={false} onToggle={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Difficulty 3 of 5" })).toBeInTheDocument();
  });

  it("drops aria-pressed for the one pill that is an action", () => {
    renderWithProviders(<ToggleChip label="Show all (37)" onToggle={vi.fn()} />);
    // Announcing an action as an unpressed toggle promises a state it has not.
    expect(screen.getByRole("button", { name: "Show all (37)" })).not.toHaveAttribute(
      "aria-pressed",
    );
  });
});
