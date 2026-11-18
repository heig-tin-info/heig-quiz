import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { RateRing, RingChart, ringFill, type RingPart } from "./ring";

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

describe("RateRing", () => {
  const RATE_CIRCUMFERENCE = 2 * Math.PI * 8.5;
  const arcs = (container: HTMLElement) => [...container.querySelectorAll("circle")];

  it("draws the rate as an arc on the ramp over the track, named by its sentence", () => {
    const { container } = renderWithProviders(<RateRing rate={0.833} sentence="CI: 40 of 48 points, 83%" />);
    expect(screen.getByRole("img", { name: "CI: 40 of 48 points, 83%" })).toHaveStyle({ width: "20px" });
    const [track, arc] = arcs(container);
    expect(track!.getAttribute("class")).toBe("stroke-surface-3");
    expect(track!.getAttribute("stroke-dasharray")).toBeNull();
    expect(arc!.getAttribute("class")).toBe("score-ramp-stroke");
    expect(arc!.style.getPropertyValue("--rate")).toBe("83%");
    const [dash] = arc!.getAttribute("stroke-dasharray")!.split(" ").map(Number);
    expect(dash!).toBeCloseTo(0.833 * RATE_CIRCUMFERENCE, 3);
  });

  it("draws the track alone at zero, and the whole ring past full marks", () => {
    const zero = renderWithProviders(<RateRing rate={-0.2} sentence="s" />);
    expect(arcs(zero.container)).toHaveLength(1);
    const full = renderWithProviders(<RateRing rate={1.4} sentence="s" />);
    const arc = arcs(full.container)[1]!;
    expect(arc.style.getPropertyValue("--rate")).toBe("100%");
    expect(Number(arc.getAttribute("stroke-dasharray")!.split(" ")[0])).toBeCloseTo(RATE_CIRCUMFERENCE, 3);
  });
});

describe("ringFill", () => {
  it("gives each tone the same token as its segment", () => {
    expect(ringFill("success")).toBe("bg-success");
    expect(ringFill("faint")).toBe("bg-fg-faint/50");
  });
});
