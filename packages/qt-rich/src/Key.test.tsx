/**
 * The `rich` answer key of the debrief (ADR-033, ADR-109): the model answer
 * once revealed — and never the grading criteria, at either density.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { keyHostProps } from "@quiz/ui/testing";

import { RichKey } from "./Key.js";
import type { RichSolution, RichStudent } from "./schema.js";

const STUDENT: RichStudent = { prompt: "Explain `malloc`.", format: "markdown" };
const SOLUTION: RichSolution = { rubric: "2 pts: names the heap. SECRET-CRITERIA", reference: "It allocates on the heap." };

const draw = (revealed: boolean, density: "wall" | "page", solution: RichSolution | null = SOLUTION, stats = {}) =>
  render(
    <RichKey
      {...keyHostProps(stats)}
      density={density}
      student={STUDENT}
      solution={solution}
      revealed={revealed}
      prompt={<p>the prompt</p>}
      rows={<p>the rows</p>}
      renderBlock={(source) => <div data-testid="block">{source}</div>}
    />,
  );

describe("RichKey", () => {
  it.each(["wall", "page"] as const)("shows the model answer once revealed, never the criteria (%s)", (density) => {
    const { container } = draw(true, density);
    expect(screen.getByText("the prompt")).toBeVisible();
    expect(screen.getByText("Model answer")).toBeVisible();
    // Set as blocks, through the host's renderer: lists and formulas hold.
    expect(screen.getByTestId("block")).toHaveTextContent("It allocates on the heap.");
    expect(container.innerHTML).not.toContain("SECRET-CRITERIA");
    expect(container.innerHTML).not.toContain("names the heap");
  });

  it("takes the host's words", () => {
    render(<RichKey {...keyHostProps()} student={STUDENT} solution={SOLUTION} revealed strings={{ modelAnswer: "Réponse modèle" }} />);
    expect(screen.getByText("Réponse modèle")).toBeVisible();
  });

  it("keeps the model answer hidden before the reveal", () => {
    const { container } = draw(false, "wall");
    expect(screen.queryByText("Model answer")).toBeNull();
    expect(container.innerHTML).not.toContain("It allocates");
  });

  it("draws no panel for an essay without a model answer", () => {
    draw(true, "page", { rubric: "SECRET-CRITERIA", reference: "  " });
    expect(screen.queryByText("Model answer")).toBeNull();
    expect(document.body.innerHTML).not.toContain("SECRET-CRITERIA");
  });

  it("lists answer groups only when there are some", () => {
    draw(true, "page", null);
    expect(screen.queryByText("the rows")).toBeNull();
    draw(true, "page", null, { distribution: [{ key: "a", label: "a", count: 1, correct: null, part: null }] });
    expect(screen.getByText("the rows")).toBeVisible();
  });
});
