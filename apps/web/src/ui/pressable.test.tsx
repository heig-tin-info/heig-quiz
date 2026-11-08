import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { pressable } from ".";

describe("pressable", () => {
  it("activates on Enter and on Space, and Space does not scroll the page", () => {
    const onActivate = vi.fn();
    renderWithProviders(
      <div {...pressable(onActivate)}>PRG1 2026</div>,
    );
    const card = screen.getByRole("button", { name: "PRG1 2026" });
    expect(card).toHaveAttribute("tabindex", "0");
    fireEvent.click(card);
    expect(onActivate).toHaveBeenCalledTimes(1);
    onActivate.mockClear();
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledTimes(1);
    const space = fireEvent.keyDown(card, { key: " " });
    expect(onActivate).toHaveBeenCalledTimes(2);
    // fireEvent returns false when the handler called preventDefault.
    expect(space).toBe(false);
  });

  it("leaves the role alone for a row, which must stay a row", () => {
    expect(pressable(() => {}, "row").role).toBe("row");
  });
});
