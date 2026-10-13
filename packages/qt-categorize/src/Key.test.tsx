/**
 * The `categorize` answer key of the debrief (ADR-033, ADR-109): hidden, the
 * question as the class found it; revealed, every card in its key's column,
 * the distractors in none (#801, #802).
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { keyHostProps } from "@quiz/ui/testing";

import { CategorizeKey } from "./Key.js";
import type { CategorizeSolution, CategorizeStudent } from "./schema.js";

const STUDENT = {
  prompt: "Sort the names.",
  columns: [
    { id: "snake", label: "snake_case" },
    { id: "camel", label: "camelCase" },
  ],
  cards: [
    { id: "a", text: "max_size" },
    { id: "b", text: "maxSize" },
    { id: "c", text: "MAX" },
  ],
  ordered: false,
} as CategorizeStudent;

const KEY: CategorizeSolution = {
  columns: [
    { id: "snake", cards: ["a"] },
    { id: "camel", cards: ["b"] },
  ],
};

const draw = (revealed: boolean, student = STUDENT, solution = KEY) =>
  render(
    <CategorizeKey
      {...keyHostProps()}
      student={student}
      solution={solution}
      revealed={revealed}
      prompt={<p>the prompt</p>}
      rows={<p>the rows</p>}
    />,
  );

describe("CategorizeKey", () => {
  it("keeps the prompt and draws its board in place of the answer groups", () => {
    draw(false);
    expect(screen.getByText("the prompt")).toBeVisible();
    expect(screen.queryByText("the rows")).toBeNull();
  });

  it("shows every card to sort above empty columns while hidden", () => {
    draw(false);
    expect(screen.getByText("Cards to sort")).toBeVisible();
    for (const label of ["snake_case", "camelCase"]) {
      expect(within(screen.getByRole("list", { name: label })).queryAllByRole("listitem")).toHaveLength(0);
    }
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["max_size", "maxSize", "MAX"]);
  });

  it("puts each card in its key's column once revealed, the distractor in none", () => {
    draw(true);
    expect(within(screen.getByRole("list", { name: "snake_case" })).getByRole("listitem")).toHaveTextContent("max_size");
    expect(within(screen.getByRole("list", { name: "camelCase" })).getByRole("listitem")).toHaveTextContent("maxSize");
    expect(screen.getByText("In no column")).toBeVisible();
    expect(screen.queryByText("Cards to sort")).toBeNull();
  });

  it("numbers the cards in the key's order when the order counts", () => {
    draw(true, { ...STUDENT, ordered: true }, { columns: [{ id: "snake", cards: ["c", "a"] }] });
    expect(
      within(screen.getByRole("list", { name: "snake_case" }))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["1.MAX", "2.max_size"]);
  });
});
