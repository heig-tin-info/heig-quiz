import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Trash2, UserPlus, Users } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { Actions } from "./actions";
import type { MenuItem } from "./layers";

/*
 * The shape is the component's decision, not the call site's: the same list
 * drawn twice on a screen cannot come out as a row here and a menu there.
 * What follows is that rule, case by case.
 */

const add = (onSelect = vi.fn()): MenuItem => ({
  label: "Add a staff member",
  icon: UserPlus,
  onSelect,
});
const remove: MenuItem = { label: "Delete course", icon: Trash2, danger: true };
const third: MenuItem = { label: "Rename", icon: Users };

describe("Actions", () => {
  it("draws two items as two buttons, with no menu in the way", async () => {
    const onSelect = vi.fn();
    renderWithProviders(<Actions label="Course actions" items={[add(onSelect), remove]} />);

    const group = screen.getByRole("group", { name: "Course actions" });
    expect(screen.queryByRole("button", { name: /more actions/i })).toBeNull();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(group).toContainElement(buttons[0]!);
    expect(buttons[0]).toHaveAccessibleName("Add a staff member");
    expect(buttons[1]).toHaveAccessibleName("Delete course");

    await userEvent.click(buttons[0]!);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("renders nothing at all for an empty list", () => {
    renderWithProviders(<Actions label="Course actions" items={[]} />);
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("becomes a menu at three items", async () => {
    renderWithProviders(<Actions label="Course actions" items={[add(), remove, third]} />);
    const trigger = screen.getByRole("button", { name: "Course actions" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await userEvent.click(trigger);
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
  });

  it("becomes a menu when the caller says so, whatever the count", () => {
    renderWithProviders(<Actions label="Course actions" menu items={[add(), remove]} />);
    expect(screen.getByRole("button", { name: "Course actions" })).toHaveAttribute(
      "aria-haspopup",
      "menu",
    );
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("becomes a menu when an item has no icon: there is nothing to draw", () => {
    renderWithProviders(
      <Actions label="Course actions" items={[add(), { label: "Rename", onSelect: vi.fn() }]} />,
    );
    expect(screen.getByRole("button", { name: "Course actions" })).toHaveAttribute(
      "aria-haspopup",
      "menu",
    );
  });

  it("carries danger and disabled onto the buttons", () => {
    renderWithProviders(
      <Actions
        label="Course actions"
        items={[{ ...add(), disabled: true }, remove]}
      />,
    );
    expect(screen.getByRole("button", { name: "Add a staff member" })).toBeDisabled();
    // `danger` is the hover tint, so what is asserted is the class the token
    // lives in and not a computed colour jsdom never resolves.
    expect(screen.getByRole("button", { name: "Delete course" }).className).toContain(
      "hover:text-danger",
    );
  });
});
