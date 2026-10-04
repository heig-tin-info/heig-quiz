import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { CalculatorDock } from "./CalculatorDock";

/*
 * The calculator on the player (ADR-069). The engine's arithmetic is
 * `@quiz/domain`'s (calculator.test.ts); here, what the student touches: the
 * button, the panel, the keys, the keyboard while focus is inside, and only
 * then.
 */
const display = () => screen.getByRole("status");

async function openDock(kind: "standard" | "scientific") {
  const user = userEvent.setup();
  renderWithProviders(
    <>
      <input aria-label="Answer" />
      <CalculatorDock kind={kind} />
    </>,
  );
  await user.click(screen.getByRole("button", { name: "Calculator" }));
  return user;
}

describe("the calculator dock", () => {
  it("opens from its button with focus inside, and closes on Escape back to it", async () => {
    const user = await openDock("standard");
    const panel = screen.getByRole("dialog", { name: "Calculator" });
    expect(panel).toBeVisible();
    expect(panel).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    expect(panel).not.toBeVisible();
    expect(screen.getByRole("button", { name: "Calculator" })).toHaveFocus();
  });

  it("keeps its number while closed", async () => {
    const user = await openDock("standard");
    await user.keyboard("42");
    await user.click(screen.getByRole("button", { name: "Close the calculator", expanded: true }));
    await user.click(screen.getByRole("button", { name: "Calculator" }));
    expect(display()).toHaveTextContent("42");
  });

  it("computes from its keys, with the order of operations", async () => {
    const user = await openDock("standard");
    const keys = screen.getByRole("group", { name: "Calculator keys" });
    for (const name of ["2", "Plus", "3", "Multiply by", "4", "Equals"]) {
      await user.click(within(keys).getByRole("button", { name }));
    }
    expect(display()).toHaveTextContent("14");
    expect(screen.getByText("2 + 3 × 4 =")).toBeInTheDocument();
  });

  it("is driven by the keyboard while focus is inside, and never from an answer field", async () => {
    const user = await openDock("standard");
    await user.keyboard("12*3{Enter}");
    expect(display()).toHaveTextContent("36");
    const answer = screen.getByRole("textbox", { name: "Answer" });
    await user.click(answer);
    await user.keyboard("7");
    expect(answer).toHaveValue("7");
    expect(display()).toHaveTextContent("36");
  });

  it("takes Enter as = after a click, and as the key itself on a key reached with Tab", async () => {
    const user = await openDock("standard");
    const keys = screen.getByRole("group", { name: "Calculator keys" });
    for (const name of ["2", "Plus", "3"]) await user.click(within(keys).getByRole("button", { name }));
    await user.keyboard("{Enter}");
    expect(display()).toHaveTextContent("5");
    within(keys).getByRole("button", { name: "Clear" }).focus();
    await user.keyboard("{Enter}");
    expect(display()).toHaveTextContent("0");
  });

  it("names an impossible operation", async () => {
    const user = await openDock("standard");
    await user.keyboard("5/0{Enter}");
    expect(display()).toHaveTextContent("Cannot divide by zero");
  });

  it("offers the scientific keys in the scientific mode only", async () => {
    const user = await openDock("scientific");
    expect(screen.getByRole("button", { name: "sine" })).toBeInTheDocument();
    await user.keyboard("30");
    await user.click(screen.getByRole("button", { name: "sine" }));
    expect(display()).toHaveTextContent("0.5");
    await user.click(screen.getByRole("button", { name: "Inverse functions" }));
    expect(screen.getByRole("button", { name: "inverse sine" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hyperbolic functions" }));
    expect(screen.getByRole("button", { name: "inverse hyperbolic sine" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cube" })).toBeInTheDocument();
  });

  it("has no trigonometry in the standard mode", async () => {
    await openDock("standard");
    expect(screen.queryByRole("button", { name: "sine" })).toBeNull();
    expect(screen.getByRole("button", { name: "Percent" })).toBeInTheDocument();
  });
});
