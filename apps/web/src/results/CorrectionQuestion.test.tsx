import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { splitTemplate } from "@quiz/domain/lockedTemplate";

import { byQuestionItem, makeByQuestion } from "../test/grading-fixtures";
import { renderWithProviders } from "../test/render";
import { CorrectionQuestion } from "./CorrectionQuestion";

/*
 * The key of each type on the correction's wall (F-RES-03, ADR-033): hidden,
 * the question as the class found it; revealed, its answer — for every type
 * whose key is more than a list of answer groups (#801, #802).
 */

const draw = (q: Parameters<typeof CorrectionQuestion>[0]["q"], revealed: boolean) =>
  renderWithProviders(<CorrectionQuestion q={q} number={1} revealed={revealed} explained={false} />);

const TEMPLATE = "#include <stdio.h>\n\nint main(int argc, char* argv[]) {\n\n}\n";
const REFERENCE = '#include <stdio.h>\n\nint main(int argc, char* argv[]) {\n    printf("%07d\\n", argc);\n}\n';

const CODE = makeByQuestion({
  item: byQuestionItem(0, "code"),
  student: { prompt: "Print `argc`.", segments: splitTemplate(TEMPLATE, "c") },
  solution: { referenceSolution: REFERENCE },
  casePassRate: [{ name: "none", label: "No argument", passed: 1, total: 2 }],
});

const LOCKED = "int f(void) {\n// @@lock\n    int x = 1;\n// @@endlock\n    return 0;\n}\n";

const CATEGORIZE = makeByQuestion({
  item: byQuestionItem(1, "categorize"),
  student: {
    prompt: "Sort the names.",
    columns: [
      { id: "snake", label: "snake_case" },
      { id: "camel", label: "camelCase" },
    ],
    cards: [
      { id: "a", text: "`max_size`" },
      { id: "b", text: "`maxSize`" },
      { id: "c", text: "`MAX`" },
    ],
    ordered: false,
  },
  solution: {
    columns: [
      { id: "snake", cards: ["a"] },
      { id: "camel", cards: ["b"] },
    ],
  },
  outcomes: { correct: 3, partial: 1, wrong: 0, blank: 0 },
});

describe("CorrectionQuestion, a program", () => {
  it("shows the starting code while hidden, named as such, never the reference", () => {
    draw(CODE, false);
    const start = screen.getByRole("region", { name: "Starting code" });
    expect(start.textContent).toBe(TEMPLATE);
    expect(screen.queryByText(/printf/)).toBeNull();
  });

  it("shows the reference, whole, once revealed", () => {
    draw(CODE, true);
    expect(screen.getByRole("region", { name: "Reference solution" }).textContent).toBe(REFERENCE);
  });

  it("draws a reference cut on `@@next` lines inside its template's locked text", () => {
    draw(
      {
        ...CODE,
        student: { prompt: "p", segments: splitTemplate(LOCKED, "c") },
        solution: { referenceSolution: "int f(void) {\n// @@next\n    return x;" },
      },
      true,
    );
    expect(screen.getByRole("region", { name: "Reference solution" }).textContent).toBe(
      "int f(void) {\n    int x = 1;\n    return x;\n",
    );
  });

  it("names the hatched block of a program with no template to start from", () => {
    draw({ ...CODE, student: { prompt: "p", segments: [] } }, false);
    expect(screen.getByText("Reference solution, hidden until the answers are revealed")).toBeVisible();
    expect(screen.queryByRole("region", { name: /Reference solution/ })).toBeNull();
    // The hidden reference is not in the page at all, not even transparent.
    expect(document.body.textContent).not.toContain("printf");
  });
});

describe("CorrectionQuestion, a categorize board", () => {
  it("shows every card to sort above empty columns while hidden", () => {
    draw(CATEGORIZE, false);
    expect(screen.getByText("Cards to sort")).toBeVisible();
    for (const label of ["snake_case", "camelCase"]) {
      expect(within(screen.getByRole("list", { name: label })).queryAllByRole("listitem")).toHaveLength(0);
    }
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["max_size", "maxSize", "MAX"]);
  });

  it("puts each card in its key's column once revealed, the distractor in none", () => {
    draw(CATEGORIZE, true);
    expect(within(screen.getByRole("list", { name: "snake_case" })).getByRole("listitem")).toHaveTextContent("max_size");
    expect(within(screen.getByRole("list", { name: "camelCase" })).getByRole("listitem")).toHaveTextContent("maxSize");
    expect(screen.getByText("In no column")).toBeVisible();
    expect(screen.queryByText("Cards to sort")).toBeNull();
  });

  it("numbers the cards in the key's order when the order counts", () => {
    const ordered = makeByQuestion({
      ...CATEGORIZE,
      student: { ...(CATEGORIZE.student as object), ordered: true },
      solution: { columns: [{ id: "snake", cards: ["c", "a"] }] },
    });
    draw(ordered, true);
    expect(
      within(screen.getByRole("list", { name: "snake_case" }))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["1.MAX", "2.max_size"]);
  });
});

describe("CorrectionQuestion, the other keys", () => {
  it("names a math answer's expected formulas once revealed", () => {
    const math = makeByQuestion({
      item: byQuestionItem(2, "math"),
      student: { prompt: "Derive $x^2$." },
      solution: { answers: [{ value: "2x", points: 1 }] },
      distribution: [{ key: "2x", label: "2x", count: 2, correct: true, part: null }],
    });
    draw(math, false);
    expect(screen.queryByText("Expected answer")).toBeNull();
    draw(math, true);
    expect(screen.getByText("Expected answer")).toBeVisible();
  });

  it("shows an essay's model answer once revealed, never its rubric", () => {
    const essay = makeByQuestion({
      item: byQuestionItem(3, "rich"),
      student: { prompt: "Explain `malloc`." },
      solution: { rubric: "secret-rubric", reference: "It allocates on the heap." },
    });
    draw(essay, false);
    expect(screen.queryByText("It allocates on the heap.")).toBeNull();
    draw(essay, true);
    expect(screen.getByText("Model answer")).toBeVisible();
    expect(screen.getByText("It allocates on the heap.")).toBeVisible();
    expect(screen.queryByText(/secret-rubric/)).toBeNull();
  });
});
