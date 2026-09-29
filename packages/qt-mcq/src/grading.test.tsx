/**
 * The `mcq` columns of the grading table (ADR-040): one per choice, keyed and
 * lettered canonically, a tick box per cell that says right, wrong or missed.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { mcqGrading } from "./grading.js";
import { mcqServer } from "./server.js";
import { multipleConfig } from "./test/fixtures.js";

const view = { seed: 3, itemId: "i", shuffle: false };
const config = multipleConfig({
  choices: [
    { text: "`int a[] = {1,2,3};`", correct: true },
    { text: "`int a[3] = {};`", correct: true },
    {
      text: "A very long distractor whose text goes well past the header's room",
      correct: false,
    },
    { text: "`int a[-1];`", correct: false },
  ],
});
const student = mcqServer.toStudent(config, view);
const solution = mcqServer.toSolution(config, view);
const columns = mcqGrading.columns(student, solution);

function markOf(index: number, selected: number[] | null): string | null {
  const { container } = render(
    <>{columns[index]!.cell({ answer: selected && { selected }, details: null })}</>,
  );
  return container.querySelector("[data-mark]")?.getAttribute("data-mark") ?? null;
}

describe("mcq grading columns", () => {
  it("has one column per choice, lettered in canonical order, the full text as title", () => {
    expect(columns.map((c) => c.key)).toEqual(["choice-0", "choice-1", "choice-2", "choice-3"]);
    expect(columns[0]!.label).toBe("A · int a[] = {1,2,3};");
    expect(columns[2]!.label.endsWith("…")).toBe(true);
    expect(columns[2]!.label.length).toBeLessThanOrEqual(32);
    expect(columns[2]!.title).toBe(
      "C · A very long distractor whose text goes well past the header's room",
    );
    expect(columns.every((c) => c.align === "center")).toBe(true);
  });

  it("keys the columns canonically even when the choices were shuffled for the student", () => {
    const shuffled = mcqServer.toStudent(config, { ...view, shuffle: true });
    expect(
      mcqGrading
        .columns(shuffled, solution)
        .map((c) => c.key)
        .sort(),
    ).toEqual(columns.map((c) => c.key));
  });

  it("marks a tick right or wrong, and a correct choice left out as missed", () => {
    expect(markOf(0, [0, 2])).toBe("good");
    expect(markOf(2, [0, 2])).toBe("bad");
    expect(markOf(1, [0, 2])).toBe("missed");
    expect(markOf(3, [0, 2])).toBe("off");
  });

  it("names every mark in words", () => {
    render(<>{columns[1]!.cell({ answer: { selected: [0] }, details: null })}</>);
    expect(screen.getByRole("img", { name: "Missed: correct but not ticked" })).toBeInTheDocument();
  });

  it("marks nothing as missed on a missing answer", () => {
    expect(markOf(0, null)).toBe("off");
  });

  it("fills the expected row on the correct choices only", () => {
    render(
      <>
        {columns.map((c) => (
          <span key={c.key}>{c.expected()}</span>
        ))}
      </>,
    );
    expect(screen.getAllByRole("img", { name: "Expected" })).toHaveLength(2);
    expect(screen.getAllByRole("img", { name: "Not expected" })).toHaveLength(2);
  });

  it("takes the host's words over its English defaults", () => {
    const fr = mcqGrading.columns(student, solution, { tickedCorrect: "Cochée, juste" });
    render(<>{fr[0]!.cell({ answer: { selected: [0] }, details: null })}</>);
    expect(screen.getByRole("img", { name: "Cochée, juste" })).toBeInTheDocument();
  });

  it("sorts by ticked or not, whatever else the answer holds", () => {
    const key = columns[1]!.sortKey;
    expect(key({ selected: [1] })).toBe(key({ selected: [3, 1] }));
    expect(key({ selected: [1] }) < key({ selected: [0] })).toBe(true);
    expect(key(null)).toBe(key({ selected: [] }));
  });
});
