import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { Progress } from "./feedback";

/*
 * A progress bar is announced as one (role, name, value), and says nothing
 * about a value it does not know.
 */

describe("Progress", () => {
  it("announces a determinate value, clamped, with its percentage written out", () => {
    renderWithProviders(<Progress label="Importing the roster" value={3} max={4} />);
    const bar = screen.getByRole("progressbar", { name: "Importing the roster" });
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("4");
    expect(bar.getAttribute("aria-valuenow")).toBe("3");
    expect(screen.getByText("75%")).toBeTruthy();
  });

  it("clamps a value outside the range", () => {
    renderWithProviders(<Progress label="Over" value={12} max={10} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("10");
  });

  it("writes the percentage the French way in French", () => {
    renderWithProviders(<Progress label="Import" value={1} max={2} />, { locale: "fr" });
    expect(screen.getByText(/50\s%/)).toBeTruthy();
  });

  it("has no value at all when the duration is unknown", () => {
    renderWithProviders(<Progress label="Exploring the template" />);
    const bar = screen.getByRole("progressbar", { name: "Exploring the template" });
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Exploring the template")).toBeTruthy();
  });
});
