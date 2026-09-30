import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GithubIcon } from "./brand";

describe("GithubIcon", () => {
  it("is a decorative glyph in the current colour, sized like a lucide icon", () => {
    const { container } = render(<GithubIcon className="size-4" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.getAttribute("width")).toBe("24");
    expect(svg.getAttribute("class")).toBe("size-4");
  });
});
