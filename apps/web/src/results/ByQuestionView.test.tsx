import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { clozeStudentTemplate, parseCloze } from "@quiz/domain/cloze";

import { byQuestionItem, makeByQuestion } from "../test/grading-fixtures";
import { renderWithProviders } from "../test/render";
import { ByQuestionView } from "./ByQuestionView";

/*
 * The Results "Questions" tab (F-RES-03): the teacher's reading of the
 * correction projection — the same choices, rows and blanks at the page's
 * scale, always revealed — and the type's own review for any other question.
 */


const MCQ = makeByQuestion({
  item: byQuestionItem(0, "mcq"),
  student: {
    prompt: "What is `sizeof(char)`?",
    choices: [
      { id: 0, text: "`1` byte" },
      { id: 1, text: "`2` bytes" },
    ],
    mode: "single",
  },
  solution: { correct: [0] },
  outcomes: { correct: 3, partial: 0, wrong: 1, blank: 1 },
  distribution: [
    { key: "0", label: "0", count: 3, correct: true, part: null },
    { key: "1", label: "1", count: 1, correct: false, part: null },
  ],
  successRate: 0.6,
});

const CLOZE = makeByQuestion({
  item: byQuestionItem(1, "cloze"),
  student: clozeStudentTemplate(parseCloze("Free with {{free}}."), 0, "i1", false),
  solution: { blanks: [{ index: 0, expected: "free" }] },
  outcomes: { correct: 2, partial: 0, wrong: 1, blank: 1 },
  distribution: [
    { key: "0:free", label: "free", count: 2, correct: true, part: 0 },
    { key: "0:delete", label: "delete", count: 1, correct: false, part: 0 },
  ],
  successRate: 0.5,
});

const SHORT_UNANSWERED = makeByQuestion({
  item: byQuestionItem(2, "short"),
  student: { prompt: "What does `7 / 2` print?" },
  solution: { expected: ["3"] },
});

const CODE = makeByQuestion({
  item: byQuestionItem(3, "code"),
  student: { prompt: "Write `sum`.", language: "c", template: "", regions: [] },
  solution: { referenceSolution: "return a + b;" },
  outcomes: { correct: 2, partial: 0, wrong: 1, blank: 0 },
  casePassRate: [{ name: "visible-1", label: "visible-1", passed: 2, total: 3 }],
});

describe("ByQuestionView", () => {
  it("draws an mcq as the projection does, revealed, its choices in markdown", async () => {
    renderWithProviders(<ByQuestionView questions={[MCQ]} />);
    const choices = await screen.findByRole("list");
    const [key, distractor] = within(choices).getAllByRole("listitem");
    // Inline code, never raw backticks; the count of papers at the end.
    expect(key!.textContent).toBe("A1 byte3");
    expect(key!.querySelector("code")).toHaveTextContent("1");
    expect(screen.queryByText(/`/)).toBeNull();
    // Revealed: each bar names its verdict.
    expect(within(key!).getByRole("img")).toHaveAccessibleName("correct answer · ticked: 3");
    expect(within(distractor!).getByRole("img")).toHaveAccessibleName("wrong answer · ticked: 1");
    // Nothing of an empty student copy: no "Missed", no score, no second list.
    expect(screen.queryByText(/Missed/)).toBeNull();
    expect(screen.queryByText(/Score/)).toBeNull();
    expect(screen.queryByText("Answer distribution")).toBeNull();
  });

  it("draws a cloze's blanks with their key and a right / wrong bar", async () => {
    renderWithProviders(<ByQuestionView questions={[CLOZE]} />);
    const hole = (await screen.findByText("free")).parentElement!;
    expect(within(hole).getByRole("img")).toHaveAccessibleName("correct: 2 · wrong: 1");
  });

  it("draws a short answer's key itself, even with nobody to count", async () => {
    renderWithProviders(<ByQuestionView questions={[SHORT_UNANSWERED]} />);
    expect(await screen.findByText("Nobody answered this question.")).toBeVisible();
    expect(screen.getByText("Expected answer")).toBeVisible();
    // Never the empty student copy of the type's review.
    expect(screen.queryByText(/Score/)).toBeNull();
  });

  it("names a parameterized question's example values, and draws its blanks without a bar (ADR-056 §9)", async () => {
    const param = makeByQuestion({
      ...CLOZE,
      parameterized: true,
      student: clozeStudentTemplate(parseCloze("It falls for {{#3.03:1%}} s."), 0, "i1", false),
      solution: { blanks: [{ index: 0, expected: "3.03 ± 1%" }] },
      distribution: [],
    });
    renderWithProviders(<ByQuestionView questions={[param]} />);
    expect(await screen.findByText("Example values: each student had their own numbers.")).toBeVisible();
    const hole = screen.getByText("3.03 ± 1%");
    // The verdicts are the head's: no right / wrong split by what was written.
    expect(within(hole.parentElement!).queryByRole("img")).toBeNull();
  });

  it("lists no answer rows under a parameterized short answer: the head holds its verdicts", async () => {
    const param = makeByQuestion({
      item: byQuestionItem(2, "short"),
      parameterized: true,
      student: { prompt: "Dropped from 42 m: how long?" },
      solution: { expected: ["2.93"] },
      outcomes: { correct: 2, partial: 0, wrong: 1, blank: 1 },
      distribution: [],
    });
    renderWithProviders(<ByQuestionView questions={[param]} />);
    expect(await screen.findByText("2.93")).toBeVisible();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("leaves any other type's statement to its review, with the program below", async () => {
    renderWithProviders(<ByQuestionView questions={[CODE]} />);
    expect(await screen.findByText("Not answered.")).toBeVisible();
    expect(screen.getByRole("region", { name: "Reference solution" })).toHaveTextContent("return a + b;");
    // Printed once: the review keeps it for a graded answer.
    expect(screen.getAllByText("return a + b;")).toHaveLength(1);
    const cases = screen.getByRole("list", { name: "Test cases" });
    expect(within(cases).getByText("2 of 3")).toBeVisible();
    expect(within(cases).getByRole("img")).toHaveAccessibleName("passed: 2 · failed: 1");
  });
});

describe("the head of the Questions tab", () => {
  it("draws one column per question and names the hardest and the best answered", () => {
    renderWithProviders(<ByQuestionView questions={[MCQ, CLOZE, SHORT_UNANSWERED]} />);

    const chart = screen.getByRole("table", { name: "Question distribution" });
    const rows = within(chart).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(["Question 13011", "Question 22011", "Question 30000"]);

    // Two rated questions: 60 % and 50 %, so a 55 % mean; the unanswered one has no rate.
    expect(screen.getByText("Mean success").parentElement).toHaveTextContent("55%");
    expect(screen.getByText("Hardest").parentElement).toHaveTextContent("Q2");
    expect(screen.getByText("Best answered").parentElement).toHaveTextContent("Q1");
    // Two blanks over the nine papers counted.
    expect(screen.getByText("No answer").parentElement).toHaveTextContent("2 / 9");
  });
});
