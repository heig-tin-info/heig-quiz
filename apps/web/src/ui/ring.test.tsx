import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { RingChart, ringFill, type RingPart } from "./ring";

const parts: RingPart[] = [
  { value: 26, tone: "success" },
  { value: 3, tone: "warning" },
  { value: 0, tone: "danger" },
  { value: 1, tone: "faint" },
];
const CIRCUMFERENCE = 2 * Math.PI * 15.5;

describe("RingChart", () => {
  it("is a focusable image named by its sentence, with the figure in the hole", () => {
    renderWithProviders(<RingChart parts={parts} hole="87" sentence="26 ready · 3 pending · 1 none" />);
    const ring = screen.getByRole("img", { name: "26 ready · 3 pending · 1 none" });
    expect(ring).toHaveAttribute("tabindex", "0");
    expect(ring).toHaveTextContent("87");
  });

  it("draws the parts in the order given, skips a part of zero and parts the others with a gap", () => {
    const { container } = renderWithProviders(<RingChart parts={parts} sentence="s" />);
    const circles = [...container.querySelectorAll("circle")];
    expect(circles.map((c) => c.getAttribute("class"))).toEqual(["stroke-success", "stroke-warning", "stroke-fg-faint/50"]);
    // Each segment starts where the previous one ended, clockwise.
    const offsets = circles.map((c) => Number(c.getAttribute("stroke-dashoffset")));
    expect(offsets[1]).toBeLessThan(offsets[0]!);
    expect(offsets[2]).toBeLessThan(offsets[1]!);
    // A 2 px gap is cut from the end of each segment.
    const first = circles[0]!.getAttribute("stroke-dasharray")!.split(" ").map(Number);
    expect(first[0]).toBeCloseTo((26 / 30) * CIRCUMFERENCE - 2, 3);
  });

  it("draws a single part with no gap, and nothing at all for an empty ring", () => {
    const one = renderWithProviders(<RingChart parts={[{ value: 5, tone: "success" }]} sentence="s" />);
    const dash = one.container.querySelector("circle")!.getAttribute("stroke-dasharray")!.split(" ").map(Number);
    expect(dash[0]).toBeCloseTo(CIRCUMFERENCE, 3);
    const none = renderWithProviders(<RingChart parts={[{ value: 0, tone: "success" }]} sentence="s" />);
    expect(none.container.querySelectorAll("circle")).toHaveLength(0);
  });

  it("leaves the rest of the ring empty when the total is larger than the parts", () => {
    const { container } = renderWithProviders(<RingChart parts={[{ value: 1, tone: "success" }]} total={4} sentence="s" />);
    const [dash] = container.querySelector("circle")!.getAttribute("stroke-dasharray")!.split(" ").map(Number);
    expect(dash!).toBeCloseTo(CIRCUMFERENCE / 4, 3);
  });
});

describe("ringFill", () => {
  it("gives each tone the same token as its segment", () => {
    expect(ringFill("success")).toBe("bg-success");
    expect(ringFill("faint")).toBe("bg-fg-faint/50");
  });
});
