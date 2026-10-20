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

const draw = (q: Parameters<typeof CorrectionQuestion>[0]["q"], revealed: boolean, explained = false, locale?: "fr") =>
  renderWithProviders(
    <CorrectionQuestion q={q} number={1} revealed={revealed} explained={explained} />,
    locale === undefined ? {} : { locale },
  );

const TEMPLATE = "#include <stdio.h>\n\nint main(void) {\n\n}\n";
const REFERENCE = '#include <stdio.h>\n\nint main(void) {\n    printf("hi");\n}\n';

const CODE = makeByQuestion({
  item: byQuestionItem(0, "code"),
  student: { prompt: "Print `hi`.", segments: splitTemplate(TEMPLATE, "c") },
  solution: { referenceSolution: REFERENCE },
  explanation: "`printf` writes to stdout.",
  outcomes: { correct: 1, partial: 0, wrong: 1, blank: 2 },
  casePassRate: [{ name: "hidden-1", label: "Hidden case 1", passed: 1, total: 2 }],
});

describe("CorrectionQuestion, a program", () => {
  it("lends its key the test cases, set beside the code, after the explanation", async () => {
    expect(drawsKey("code")).toBe(true);
    draw(CODE, true, true);
    const code = await screen.findByRole("region", { name: "Reference solution" });
    const cases = screen.getByRole("list", { name: "Test cases" });
    expect(code.closest("figure")!.parentElement).toBe(cases.parentElement);
    const explanation = screen.getByText("writes to stdout.", { exact: false });
    expect(explanation.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // `label`, never `name` (ADR-033); the papers it never ran on, "not run".
    expect(within(cases).getByText("Hidden case 1")).toBeVisible();
    expect(screen.queryByText("hidden-1")).toBeNull();
    expect(within(cases).getByRole("img")).toHaveAccessibleName("passed: 1 · failed: 1 · not run: 2");
  });
});

describe("CorrectionQuestion, an essay", () => {
  it("shows an essay's model answer once revealed, never its rubric", async () => {
    const essay = makeByQuestion({
      item: byQuestionItem(3, "rich"),
      student: { prompt: "Explain `malloc`.", format: "markdown" },
      solution: { rubric: "secret-rubric", reference: "It allocates on the heap." },
    });
    expect(drawsKey("rich")).toBe(true);
    draw(essay, false);
    await screen.findAllByText("malloc", { exact: false });
    expect(screen.queryByText("It allocates on the heap.")).toBeNull();
    draw(essay, true);
    expect(await screen.findByText("Model answer")).toBeVisible();
    expect(screen.getByText("It allocates on the heap.")).toBeVisible();
    expect(document.body.innerHTML).not.toContain("secret-rubric");
  });
});

describe("CorrectionQuestion, a canvas", () => {
  const BLOCKS = makeByQuestion({
    item: byQuestionItem(7, "blocks"),
    student: {
      prompt: "Reach the dock.",
      toolbox: ["forward"],
      starter: [],
      visibleCases: [{ name: "Aisle", map: [">..D"], battery: 9, points: 1 }],
    },
    solution: {
      referenceSolution: [{ kind: "forward" }],
      cases: [{ name: "Secret aisle", map: ["^.D"], battery: 9, points: 1, visible: false }],
    },
    outcomes: { correct: 2, partial: 0, wrong: 1, blank: 0 },
    casePassRate: [{ name: "w1", label: "Warehouse 1", passed: 2, total: 3 }],
  });

  it("lends a program of blocks its warehouses' bars, beside its program in the canvas's words", async () => {
    expect(drawsKey("blocks")).toBe(true);
    draw(BLOCKS, true, undefined, "fr");
    const program = await screen.findByRole("region", { name: "Corrigé" });
    expect(program).toHaveTextContent("avancer");
    const cases = screen.getByRole("list", { name: "Cas de test" });
    expect(within(cases).getByText("Warehouse 1")).toBeVisible();
    expect(cases.parentElement).toBe(screen.getByRole("list", { name: "Entrepôts" }).parentElement);
    // A hidden warehouse is never drawn, even revealed.
    expect(document.body.innerHTML).not.toContain("Secret aisle");
  });

  it("draws a diagram's and a circuit's reference only once revealed", async () => {
    expect(drawsKey("diagram")).toBe(true);
    expect(drawsKey("circuit")).toBe(true);
    const diagram = makeByQuestion({
      item: byQuestionItem(4, "diagram"),
      student: { prompt: "Draw the classes.", kind: "class" },
      solution: { reference: { nodes: [{ id: "n1", t: "class", x: 0, y: 0, name: "SecretShape" }], links: [] }, rubric: "secret-rubric" },
    });
    draw(diagram, false);
    expect(await screen.findByText("Reference diagram, hidden until the answers are revealed")).toBeVisible();
    expect(document.body.innerHTML).not.toContain("SecretShape");
    draw(diagram, true);
    expect(await screen.findByRole("img", { name: "Reference diagram" })).toHaveTextContent("SecretShape");
    expect(document.body.innerHTML).not.toContain("secret-rubric");
  });
});

describe("CorrectionQuestion, a type without a key of its own", () => {
  const BRAINSTORM = makeByQuestion({
    item: byQuestionItem(4, "brainstorm"),
    student: { prompt: "Draw the automaton." },
    outcomes: { correct: 2, partial: 0, wrong: 1, blank: 1 },
    distribution: [
      { key: "a", label: "accepted", count: 2, correct: true, part: null },
      { key: "b", label: "refused", count: 1, correct: false, part: null },
    ],
  });

  it("draws the prompt and the answer groups, the blanks last", () => {
    expect(drawsKey("brainstorm")).toBe(false);
    draw(BRAINSTORM, true);
    expect(screen.getByText("Draw the automaton.")).toBeVisible();
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows.map((li) => li.textContent)).toEqual(["accepted2", "refused1", "no answer1"]);
  });

  it("still shows test cases it would count, rather than dropping them", () => {
    draw({ ...BRAINSTORM, casePassRate: [{ name: "c1", label: "Case 1", passed: 1, total: 2 }] }, true);
    const cases = screen.getByRole("list", { name: "Test cases" });
    expect(within(cases).getByText("Case 1")).toBeVisible();
  });

  it("lists no lone blanks: they say nothing the head does not", () => {
    draw({ ...BRAINSTORM, distribution: [] }, true);
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
