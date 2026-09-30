import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Progress } from "./feedback";

/*
 * A progress bar of unknown length is announced as one (role, name, busy),
 * and says nothing about a value it does not know.
 */

describe("Progress", () => {
  it("is a busy progressbar named by its label, with no value", () => {
    render(<Progress label="Exploring the template" />);
    const bar = screen.getByRole("progressbar", { name: "Exploring the template" });
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Exploring the template")).toBeTruthy();
  });
});
