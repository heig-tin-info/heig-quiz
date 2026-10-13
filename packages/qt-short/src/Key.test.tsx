/**
 * The `short` answer key of the debrief (ADR-033, ADR-109): the accepted
 * answers above the host's answer groups, once revealed.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { keyHostProps } from "@quiz/ui/testing";

import { ShortKey } from "./Key.js";
import type { ShortSolution, ShortStudent } from "./schema.js";

const grouped = { distribution: [{ key: "3", label: "3", count: 1, correct: true, part: null }] };

const draw = (revealed: boolean, solution: ShortSolution | null, stats = grouped) =>
  render(
    <ShortKey
      {...keyHostProps(stats)}
      student={{ prompt: "What does `7 / 2` print?" } as ShortStudent}
      solution={solution}
      revealed={revealed}
      prompt={<p>the prompt</p>}
      rows={<p>the rows</p>}
    />,
  );

describe("ShortKey", () => {
  it("names the accepted answers above the groups once revealed", () => {
    draw(true, { expected: ["3", "3.0"] });
    expect(screen.getByText("the prompt")).toBeVisible();
    expect(screen.getByText("Expected answer").textContent).toBe("Expected answer 3 · 3.0");
    expect(screen.getByText("the rows")).toBeVisible();
  });

  it("keeps them hidden, the groups shown, before the reveal", () => {
    draw(false, { expected: ["3"] });
    expect(screen.queryByText("Expected answer")).toBeNull();
    expect(screen.getByText("the rows")).toBeVisible();
  });

  it("lists no lone blanks when the key names no answer", () => {
    draw(true, null, { distribution: [] });
    expect(screen.queryByText("the rows")).toBeNull();
    expect(screen.getByText("the prompt")).toBeVisible();
  });
});
