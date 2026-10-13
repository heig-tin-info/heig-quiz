/**
 * The `math` answer key of the debrief (ADR-033, ADR-109): the accepted
 * formulas, set as math with their credit below full marks, above the
 * host's answer groups once revealed.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { keyHostProps } from "@quiz/ui/testing";

import { MathKey } from "./Key.js";
import type { MathStudent } from "./schema.js";

const draw = (revealed: boolean) =>
  render(
    <MathKey
      {...keyHostProps({ distribution: [{ key: "2x", label: "2x", count: 2, correct: true, part: null }] })}
      student={{ prompt: "Derive $x^2$." } as MathStudent}
      solution={{ answers: [{ value: "2x", points: 1 }, { value: "2*x", points: 0.5 }] }}
      revealed={revealed}
      prompt={<p>the prompt</p>}
      rows={<p>the rows</p>}
    />,
  );

describe("MathKey", () => {
  it("names the expected formulas once revealed, each set as math", () => {
    draw(true);
    expect(screen.getByText("Expected answer").textContent).toBe("Expected answer $2x$ · $2*x$ (0.5)");
    expect(screen.getByText("the rows")).toBeVisible();
  });

  it("names none before the reveal", () => {
    draw(false);
    expect(screen.queryByText("Expected answer")).toBeNull();
    expect(screen.getByText("the prompt")).toBeVisible();
  });
});
