import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { Menu, Z, type MenuItem } from ".";

describe("Menu", () => {
  const items = (onSelect: () => void): MenuItem[] => [
    { label: "Clone script", onSelect },
    { label: "Export", disabled: true },
    { label: "Documentation", href: "https://example.org/docs" },
    { label: "Delete", danger: true, separator: true, onSelect: () => {} },
  ];

  const renderMenu = (onSelect = vi.fn()) => {
    renderWithProviders(<Menu label="Assignment actions" items={items(onSelect)} />);
    return { trigger: screen.getByRole("button", { name: "Assignment actions" }), onSelect };
  };

  it("announces itself as a menu button and opens on click", async () => {
    const { trigger } = renderMenu();
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Assignment actions" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(4);
  });

  it("opens on ArrowDown with the first item focused, and wraps with the arrows", async () => {
    const { trigger } = renderMenu();
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    const menu = screen.getByRole("menu");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Clone script" }));
    // "Export" is disabled: the arrows step over it.
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      within(menu).getByRole("menuitem", { name: "Documentation" }),
    );
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Delete" }));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      within(menu).getByRole("menuitem", { name: "Clone script" }),
    );
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Delete" }));
  });

  it("opens on ArrowUp with the last item focused", async () => {
    const { trigger } = renderMenu();
    trigger.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "Delete" }),
    );
  });

  it("selects with Enter, then closes and restores the focus", async () => {
    const { trigger, onSelect } = renderMenu();
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape and restores the focus", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on an outside click", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders an href item as a link and a disabled item as disabled", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    const menu = screen.getByRole("menu");
    const link = within(menu).getByRole("menuitem", { name: "Documentation" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "https://example.org/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(within(menu).getByRole("menuitem", { name: "Export" })).toBeDisabled();
  });

  it("stacks its panel above the dialog layer, not under it", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    // The account menu opens from inside the mobile drawer, which is a z-50
    // layer: a popover below that is simply invisible.
    expect(screen.getByRole("menu")).toHaveClass(Z.popover);
    expect(Number(Z.popover.replace("z-", ""))).toBeGreaterThan(
      Number(Z.modal.replace("z-", "")),
    );
    expect(Number(Z.popover.replace("z-", ""))).toBeLessThan(
      Number(Z.overlay.replace("z-", "")),
    );
  });

  it("carries a description as a second line under the label", async () => {
    renderWithProviders(
      <Menu
        label="Assignment actions"
        items={[
          {
            label: "Clone script",
            description: "Clones every student repository into one folder",
          },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Assignment actions" }));
    const item = within(screen.getByRole("menu")).getByRole("menuitem", {
      name: /Clone script/,
    });
    expect(
      within(item).getByText("Clones every student repository into one folder"),
    ).toBeVisible();
  });

  it("closes on a page scroll, whose target is the window, and stays open on its own (audit 10-03 W1)", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    // Past the opening's grace period: a scroll now is the reader leaving.
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
    try {
      fireEvent.scroll(screen.getByRole("menu"));
      expect(screen.getByRole("menu")).toBeVisible();
      // `window` is not a Node: `contains` would throw on it.
      expect(() => fireEvent.scroll(window)).not.toThrow();
      expect(screen.queryByRole("menu")).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it("nudges a panel that would hang off the left edge back inside the viewport (audit 10-03 W2)", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(300);
    // The trigger, 30 px wide, 10 px from the left edge.
    const rect = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue(DOMRect.fromRect({ x: 10, y: 10, width: 30, height: 30 }));
    try {
      await userEvent.click(renderMenu().trigger);
      // Right-aligned on a trigger ending at 40 px: 300 px wide, it would start
      // at -260 px; it is shifted to the 8 px margin.
      expect(screen.getByRole("menu").style.marginLeft).toBe("268px");
    } finally {
      width.mockRestore();
      rect.mockRestore();
    }
  });
});
