import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { Ring } from ".";

describe("Ring", () => {
  it("is a named figure whose middle is hidden from the reader", () => {
    renderWithProviders(
      <Ring value={18} max={24} label="18 of 24 students present">
        <span>75%</span>
      </Ring>,
    );
    const ring = screen.getByRole("img", { name: "18 of 24 students present" });
    expect(ring.querySelector("svg")).toHaveAttribute("aria-hidden");
    expect(screen.getByText("75%").closest("[aria-hidden]")).not.toBeNull();
  });

  it("draws the arc in proportion, and the whole circle when full", () => {
    const dash = (value: number, max: number) => {
      const { container, unmount } = renderWithProviders(
        <Ring value={value} max={max} size={100} thickness={10} label="ring" />,
      );
      const arc = container.querySelectorAll("circle")[1]!;
      const [drawn, total] = arc.getAttribute("stroke-dasharray")!.split(" ").map(Number);
      unmount();
      return (drawn! / total!).toFixed(3);
    };
    expect(dash(0, 24)).toBe("0.000");
    expect(dash(12, 24)).toBe("0.500");
    expect(dash(24, 24)).toBe("1.000");
  });

  it("survives a zero and an out-of-range value rather than drawing NaN", () => {
    const { container } = renderWithProviders(<Ring value={5} max={0} size={100} label="ring" />);
    const arc = container.querySelectorAll("circle")[1]!;
    expect(arc.getAttribute("stroke-dasharray")).not.toContain("NaN");
  });
});
