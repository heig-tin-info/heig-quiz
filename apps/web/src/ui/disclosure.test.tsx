import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Disclosure } from "./disclosure";

/*
 * A folded card: one button for the header, named by its title (and what
 * stands beside it), described by its explanation, and a body that exists
 * only while open.
 */

describe("Disclosure", () => {
  it("starts folded, and the header toggles the body and aria-expanded", async () => {
    render(
      <Disclosure title="Advanced options" desc="Rarely needed.">
        <p>Inside</p>
      </Disclosure>,
    );
    const header = screen.getByRole("button", { name: "Advanced options" });
    expect(header).toHaveAccessibleDescription("Rarely needed.");
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(header).not.toHaveAttribute("aria-controls");
    expect(screen.queryByText("Inside")).toBeNull();

    await userEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    const body = screen.getByText("Inside").parentElement!;
    expect(header).toHaveAttribute("aria-controls", body.id);

    await userEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Inside")).toBeNull();
  });

  it("keeps what stands beside the title in view and in the name while folded", () => {
    render(
      <Disclosure title="Conditions" aside={<span>3</span>}>
        <p>Inside</p>
      </Disclosure>,
    );
    expect(screen.getByRole("button", { name: "Conditions 3" })).toHaveAttribute("aria-expanded", "false");
  });
});
