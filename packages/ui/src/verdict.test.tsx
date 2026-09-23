import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { pointsOrDash, ScoreHeader, Verdict, verdictTone } from "./verdict.js";

describe("verdictTone", () => {
  it("maps pass, fail and not judged", () => {
    expect(verdictTone(true)).toBe("success");
    expect(verdictTone(false)).toBe("danger");
    expect(verdictTone(null)).toBe("neutral");
    expect(verdictTone(undefined)).toBe("neutral");
  });
});

describe("Verdict", () => {
  it("is a badge in the tone's soft fill, with the caller's extra classes", () => {
    render(
      <Verdict tone="warning" className="ml-2">
        Missed
      </Verdict>,
    );
    const pill = screen.getByText("Missed");
    expect(pill.tagName).toBe("SPAN");
    expect(pill.className).toContain("bg-warning-soft text-warning");
    expect(pill.className.endsWith(" ml-2")).toBe(true);
  });
});

describe("ScoreHeader", () => {
  it("reads an ungraded answer as a dash, never as zero", () => {
    expect(pointsOrDash(null)).toBe("—");
    expect(pointsOrDash(0)).toBe(0);
    const { container } = render(<ScoreHeader label="Score" points={null} maxPoints={4} />);
    expect(container.textContent).toBe("Score — / 4");
  });

  it("shows the points and the type's breakdown after them", () => {
    const { container } = render(
      <ScoreHeader label="Score" points={2.5} maxPoints={4}>
        <span> · 3/4</span>
      </ScoreHeader>,
    );
    expect(container.textContent).toBe("Score 2.5 / 4 · 3/4");
  });
});
