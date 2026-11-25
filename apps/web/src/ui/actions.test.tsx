import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Trash2, UserPlus, Users } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { Actions, RowActions } from "./actions";
import type { MenuItem } from "./menu";
import { T } from "./table";

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

/*
 * A table row that becomes a row card (DESIGN.md › Row cards): on the card
 * its actions are ONE "…" holding every item, a single one included; on the
 * row they are drawn as before. Both forms are rendered, behind the very
 * container query that turns the row into a card (`T.stack`'s `@md`): jsdom
 * applies no stylesheet, so what is asserted is that switch, and that each
 * form acts.
 */
describe("RowActions", () => {
  const rowOf = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-row-actions="row"]')!;
  const cardOf = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-row-actions="card"]')!;

  it("hides the row's buttons on a card and the card's menu on a row, at T.stack's breakpoint", () => {
    const { container } = renderWithProviders(<RowActions label="Actions for Ada" items={[remove]} />);
    expect(T.stack.row).toContain("@max-md:");
    expect(rowOf(container)).toHaveClass("@max-md:hidden");
    expect(cardOf(container)).toHaveClass("@md:hidden");
    expect(within(rowOf(container)).getByRole("button", { name: "Delete course" })).toBeInTheDocument();
    expect(within(cardOf(container)).getByRole("button", { name: "Actions for Ada" })).toHaveAttribute(
      "aria-haspopup",
      "menu",
    );
  });

  it("folds even a single item into the card's menu, and it acts from there", async () => {
    const onSelect = vi.fn();
    const { container } = renderWithProviders(
      <RowActions label="Actions for Ada" items={[{ ...remove, onSelect }]} />,
    );
    const u = userEvent.setup();
    await u.click(within(cardOf(container)).getByRole("button", { name: "Actions for Ada" }));
    await u.click(await screen.findByRole("menuitem", { name: "Delete course" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("keeps the row's words when worded: one labelled button per item, quiet red when danger", async () => {
    const onSelect = vi.fn();
    const { container } = renderWithProviders(
      <RowActions worded label="Actions for Ada" items={[{ ...remove, onSelect }]} />,
    );
    const group = within(rowOf(container)).getByRole("group", { name: "Actions for Ada" });
    const button = within(group).getByRole("button", { name: "Delete course" });
    expect(button.className).toContain("text-danger");
    await userEvent.click(button);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("gives a worded button the row's name and its spinner while pending", () => {
    const { container, rerender } = renderWithProviders(
      <RowActions worded label="Actions for Ada" items={[{ ...remove, name: "Delete Ada's course" }]} />,
    );
    const button = within(rowOf(container)).getByRole("button", { name: "Delete Ada's course" });
    expect(button).toBeEnabled();
    rerender(<RowActions worded label="Actions for Ada" items={[{ ...remove, name: "Delete Ada's course", pending: true }]} />);
    expect(within(rowOf(container)).getByRole("button", { name: "Delete Ada's course" })).toBeDisabled();
    expect(rowOf(container).querySelector(".animate-spin")).not.toBeNull();
  });
});
