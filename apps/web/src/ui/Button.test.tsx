import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { Button } from ".";

/*
 * The behaviour of the primitives, not their pixels: what a keyboard reaches,
 * what a screen reader is told, what a click ends up calling. `buttonClass`,
 * `menuPosition` and `scrollEdges` keep their pure tests in ui.test.ts.
 */
describe("Button", () => {
  it("renders its label and the variant chrome", () => {
    renderWithProviders(
      <>
        <Button>Create classroom</Button>
        <Button variant="danger">Delete</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Create classroom" })).toHaveClass("bg-accent");
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("bg-danger");
  });

  it("loading disables the button and shows the spinner", async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <Button loading onClick={onClick}>
        Publish
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Publish" });
    expect(button).toBeDisabled();
    expect(button.querySelector("svg.animate-spin")).not.toBeNull();
    await userEvent.click(button).catch(() => {
      // user-event refuses to click a disabled control; that is the point.
    });
    expect(onClick).not.toHaveBeenCalled();
  });

  it("defaults to type=button, so a button in a form never submits it", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    renderWithProviders(
      <form onSubmit={onSubmit}>
        <Button>Add</Button>
      </form>,
    );
    const button = screen.getByRole("button", { name: "Add" });
    expect(button).toHaveAttribute("type", "button");
    await userEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("lets the caller ask for a submit button", () => {
    renderWithProviders(<Button type="submit">Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "submit");
  });
});
