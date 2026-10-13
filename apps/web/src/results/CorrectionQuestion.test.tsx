import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { clozeStudentTemplate, parseCloze } from "@quiz/domain/cloze";
import { splitTemplate } from "@quiz/domain/lockedTemplate";

import { byQuestionItem, makeByQuestion } from "../test/grading-fixtures";
import { renderWithProviders } from "../test/render";
import { CorrectionQuestion, drawsKey } from "./CorrectionQuestion";

/*
 * The correction's wall (F-RES-03, ADR-033): hidden, the question as the
 * class found it; revealed, its answer. A type with an answer key of its own
 * (`QuestionTypeClient.Key`, ADR-109) is tested in its package; here, what
 * the host draws itself — a program, an essay's model answer, the prompt and
 * answer groups of a type without a key — and how it frames a type's key.
 */

const draw = (q: Parameters<typeof CorrectionQuestion>[0]["q"], revealed: boolean, explained = false) =>
  renderWithProviders(<CorrectionQuestion q={q} number={1} revealed={revealed} explained={explained} />);

const TEMPLATE = "#include <stdio.h>\n\nint main(int argc, char* argv[]) {\n\n}\n";
const REFERENCE = '#include <stdio.h>\n\nint main(int argc, char* argv[]) {\n    printf("%07d\\n", argc);\n}\n';

const CODE = makeByQuestion({
  item: byQuestionItem(0, "code"),
  student: { prompt: "Print `argc`.", segments: splitTemplate(TEMPLATE, "c") },
  solution: { referenceSolution: REFERENCE },
  casePassRate: [{ name: "none", label: "No argument", passed: 1, total: 2 }],
});

const LOCKED = "int f(void) {\n// @@lock\n    int x = 1;\n// @@endlock\n    return 0;\n}\n";

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

describe("CorrectionQuestion, an essay", () => {
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

describe("CorrectionQuestion, a type without a key of its own", () => {
  const DIAGRAM = makeByQuestion({
    item: byQuestionItem(4, "diagram"),
    student: { prompt: "Draw the automaton." },
    outcomes: { correct: 2, partial: 0, wrong: 1, blank: 1 },
    distribution: [
      { key: "a", label: "accepted", count: 2, correct: true, part: null },
      { key: "b", label: "refused", count: 1, correct: false, part: null },
    ],
  });

  it("draws the prompt and the answer groups, the blanks last", () => {
    expect(drawsKey("diagram")).toBe(false);
    draw(DIAGRAM, true);
    expect(screen.getByText("Draw the automaton.")).toBeVisible();
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows.map((li) => li.textContent)).toEqual(["accepted2", "refused1", "no answer1"]);
  });

  it("lists no lone blanks: they say nothing the head does not", () => {
    draw({ ...DIAGRAM, distribution: [] }, true);
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("CorrectionQuestion, the frame of a type's key", () => {
  const MCQ = makeByQuestion({
    item: byQuestionItem(5, "mcq"),
    student: { prompt: "What is `sizeof(char)`?", choices: [{ id: 0, text: "1 byte" }], mode: "single" },
    solution: { correct: [0] },
    explanation: "By definition of the standard.",
    outcomes: { correct: 1, partial: 0, wrong: 0, blank: 0 },
    distribution: [{ key: "0", label: "0", count: 1, correct: true, part: null }],
  });

  it("draws the statement while the key arrives, then the key below it", async () => {
    expect(drawsKey("mcq")).toBe(true);
    draw(MCQ, true);
    expect(screen.getByText("sizeof(char)", { exact: false })).toBeVisible();
    expect(await screen.findByRole("list")).toHaveTextContent("A1 byte1");
  });

  it("keeps the explanation between the statement and the key", async () => {
    draw(MCQ, true, true);
    const choices = await screen.findByRole("list");
    const explanation = screen.getByText("By definition of the standard.");
    expect(explanation.compareDocumentPosition(choices) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("names a parameterized statement the type draws itself as the example's (ADR-056 §9)", async () => {
    draw(
      makeByQuestion({
        item: byQuestionItem(6, "cloze"),
        parameterized: true,
        student: clozeStudentTemplate(parseCloze("It falls for {{#3.03:1%}} s."), 0, "i1", false),
        solution: { blanks: [{ index: 0, expected: "3.03 ± 1%" }] },
      }),
      true,
    );
    const key = await screen.findByText("3.03 ± 1%");
    const caption = screen.getByText("Example values: each student had their own numbers.");
    expect(caption.parentElement!.contains(key)).toBe(true);
  });
});
