import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ByQuestion } from "@quiz/contracts";
import { clozeStudentTemplate, parseCloze } from "@quiz/domain/cloze";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { BAR_TONES } from "../ui";
import { CorrectionProjection } from "./CorrectionProjection";

/*
 * The correction projected in class (F-RES-03, ADR-033): the key and the
 * verdicts hidden until R, the explanation behind E, the questions walked
 * with the arrows.
 */

const BY_QUESTION = "/app/api/evaluations/e1/results/by-question";

function question(over: Partial<ByQuestion> & Pick<ByQuestion, "item">): ByQuestion {
  return {
    student: null,
    solution: null,
    explanation: null,
    outcomes: { correct: 0, partial: 0, wrong: 0, blank: 0 },
    distribution: [],
    casePassRate: [],
    successRate: null,
    avgMs: null,
    ...over,
  };
}

const item = (position: number, type: string) => ({
  id: `i${position}`,
  position,
  // Never on the wall (invariant 4): only the number and the type are.
  internalName: `secret-name-${position}`,
  type,
  points: 1,
  successRate: null,
});

const MCQ = question({
  item: item(0, "mcq"),
  student: { prompt: "What is `sizeof(char)`?", choices: [{ id: 0, text: "`1` byte" }, { id: 1, text: "`2` bytes" }], mode: "single" },
  solution: { correct: [0] },
  explanation: "By definition of the standard.",
  outcomes: { correct: 2, partial: 0, wrong: 1, blank: 1 },
  distribution: [
    { key: "0", label: "0", count: 2, correct: true, part: null },
    { key: "1", label: "1", count: 1, correct: false, part: null },
  ],
  successRate: 0.5,
});

const SHORT = question({
  item: item(1, "short"),
  student: { prompt: "What does `7 / 2` print?" },
  solution: { expected: ["3"] },
  outcomes: { correct: 1, partial: 0, wrong: 1, blank: 0 },
  distribution: [
    { key: "3", label: "3", count: 1, correct: true, part: null },
    { key: "3.5", label: "3.5", count: 1, correct: false, part: null },
  ],
  successRate: 0.5,
});

const CODE = question({
  item: item(2, "code"),
  student: { prompt: "Write `sum`." },
  solution: { referenceSolution: "return a + b;" },
  outcomes: { correct: 1, partial: 0, wrong: 1, blank: 0 },
  casePassRate: [
    { name: "visible-1", label: "visible-1", passed: 2, total: 2 },
    // The server labels a hidden case as a student reads it (ADR-033).
    { name: "hidden-overflow", label: "#2", passed: 1, total: 2 },
  ],
});

const CLOZE = question({
  item: item(3, "cloze"),
  student: clozeStudentTemplate(parseCloze("Free with {{free}}."), 0, "i3", false),
  solution: { blanks: [{ index: 0, expected: "free" }] },
  outcomes: { correct: 2, partial: 0, wrong: 1, blank: 1 },
  distribution: [
    { key: "0:free", label: "free", count: 2, correct: true, part: 0 },
    { key: "0:delete", label: "delete", count: 1, correct: false, part: 0 },
  ],
});

function render() {
  mockFetch({
    [`GET ${BY_QUESTION}`]: ok([MCQ, SHORT, CODE, CLOZE]),
    "GET /app/api/evaluations/e1": fail(404),
  });
  return renderWithProviders(<CorrectionProjection evaluationId="e1" navigate={vi.fn()} />);
}

describe("CorrectionProjection", () => {
  it("opens with the answers hidden, the numbers and types but never the internal name", async () => {
    render();
    const first = await screen.findByRole("region", { name: "Question 1" });
    expect(within(first).getByText("Multiple choice", { exact: false })).toBeVisible();
    expect(screen.queryByText(/secret-name/)).toBeNull();
    // The class in one bar, with its figures in words.
    expect(within(first).getByRole("img", { name: /correct: 2 · wrong: 1 · no answer: 1/ })).toBeVisible();
    // Hidden: the ticks of each choice, counted, named without a verdict and
    // drawn without one; no expected answer on the wall.
    const choices = within(first).getByRole("list");
    expect(within(choices).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["A1 byte2", "B2 bytes1"]);
    expect(within(choices).getAllByRole("img").map((bar) => bar.getAttribute("aria-label"))).toEqual([
      "ticked: 2",
      "ticked: 1",
    ]);
    expect(choices.querySelector(`.${BAR_TONES.success}, .${BAR_TONES.danger}`)).toBeNull();
    expect(screen.queryByText("Expected answer")).toBeNull();
    expect(screen.getByRole("button", { name: /Reveal the answers/ })).toBeVisible();
  });

  it("reveals the key and the verdicts on R, and hides them again", async () => {
    render();
    const first = await screen.findByRole("region", { name: "Question 1" });
    await userEvent.keyboard("r");
    // One bar per choice, the share of the papers that ticked it, named with
    // its verdict — never "no answer", which is the head bar's alone.
    const choices = within(first).getByRole("list");
    expect(within(choices).getAllByRole("img").map((bar) => bar.getAttribute("aria-label"))).toEqual([
      "correct answer · ticked: 2",
      "wrong answer · ticked: 1",
    ]);
    expect(choices.querySelector(`.${BAR_TONES.warning}`)).toBeNull();
    expect(screen.getByText("Expected answer")).toBeVisible();
    expect(screen.getByRole("button", { name: /Hide the answers/ })).toBeVisible();
    await userEvent.keyboard("r");
    expect(within(first).queryByRole("img", { name: /answer · ticked/ })).toBeNull();
  });

  it("shows the explanation on E, only where there is one", async () => {
    render();
    await screen.findByRole("region", { name: "Question 1" });
    expect(screen.queryByText("By definition of the standard.")).toBeNull();
    await userEvent.keyboard("e");
    expect(screen.getByText("By definition of the standard.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Explanation" })).toHaveAttribute("aria-pressed", "true");
  });

  it("walks the questions with the arrows, the stepper following", async () => {
    render();
    await screen.findByRole("region", { name: "Question 1" });
    const steps = screen.getByRole("navigation", { name: "Questions" });
    expect(within(steps).getByRole("button", { name: "Question 1" })).toHaveAttribute("aria-current", "step");
    await userEvent.keyboard("{ArrowDown}");
    expect(within(steps).getByRole("button", { name: "Question 2" })).toHaveAttribute("aria-current", "step");
    // The second question has no explanation: nothing to switch on.
    expect(screen.queryByRole("button", { name: "Explanation" })).toBeNull();
    // The walk stops at the last question.
    await userEvent.keyboard("{PageDown}{PageDown}{PageDown}");
    expect(within(steps).getByRole("button", { name: "Question 4" })).toHaveAttribute("aria-current", "step");
    await userEvent.keyboard("kkk");
    expect(within(steps).getByRole("button", { name: "Question 1" })).toHaveAttribute("aria-current", "step");
  });

  it("draws a blank's filled share muted, and its right / wrong split once revealed", async () => {
    render();
    const fourth = await screen.findByRole("region", { name: "Question 4" });
    const hole = within(fourth).getByText("free").parentElement!;
    // Hidden: how far the class got, in one length — the split IS the key.
    expect(within(hole).getByRole("img")).toHaveAccessibleName("filled in: 3");
    await userEvent.keyboard("r");
    // Right and wrong over the track: the empty blank is not a part.
    expect(within(hole).getByRole("img")).toHaveAccessibleName("correct: 2 · wrong: 1");
  });

  it("names a hidden test case by its label, never by its name", async () => {
    render();
    const third = await screen.findByRole("region", { name: "Question 3" });
    expect(within(third).getByText("#2")).toBeVisible();
    expect(screen.queryByText("hidden-overflow")).toBeNull();
  });

  it("says, in the reader's language, that an open evaluation has no correction yet", async () => {
    mockFetch({
      [`GET ${BY_QUESTION}`]: fail(409, { error: "not_over", message: "server words" }),
      "GET /app/api/evaluations/e1": fail(404),
    });
    renderWithProviders(<CorrectionProjection evaluationId="e1" navigate={vi.fn()} />);
    expect(
      await screen.findByText("The questions and their correction open once the evaluation is closed."),
    ).toBeVisible();
    expect(screen.queryByText("server words")).toBeNull();
  });
});
