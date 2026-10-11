import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge, Progress } from "./feedback";

/*
 * A progress bar of unknown length is announced as one (role, name, busy),
 * and says nothing about a value it does not know.
 */

describe("Badge", () => {
  it("passes its variant through: outline draws the outline face (ADR-104)", () => {
    render(
      <Badge tone="green" variant="outline">
        released
      </Badge>,
    );
    expect(screen.getByText("released").className).toContain("ring-current");
  });
});

describe("Progress", () => {
  it("is a busy progressbar named by its label, with no value", () => {
    render(<Progress label="Exploring the template" />);
    const bar = screen.getByRole("progressbar", { name: "Exploring the template" });
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Exploring the template")).toBeTruthy();
  });
});
