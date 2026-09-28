import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StrokeIcon, typeIcon } from "./icon.js";

describe("StrokeIcon", () => {
  it("draws a decorative outline in the current colour", () => {
    const { container } = render(
      <StrokeIcon size={16} strokeWidth={2}>
        <path d="M5 12h14" />
      </StrokeIcon>,
    );
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("stroke-width")).toBe("2");
    expect(svg.getAttribute("width")).toBe("16");
  });
});

describe("typeIcon", () => {
  it("takes the caller's class, else its own default", () => {
    const Icon = typeIcon(<path d="M5 12h14" />, "size-4");
    const { container, rerender } = render(<Icon />);
    expect(container.querySelector("svg")!.getAttribute("class")).toBe("size-4");
    expect(container.querySelector("svg")!.hasAttribute("width")).toBe(false);
    rerender(<Icon className="size-5" />);
    expect(container.querySelector("svg")!.getAttribute("class")).toBe("size-5");
  });
});
