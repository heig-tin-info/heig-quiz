import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GradingEntry } from "@quiz/contracts";

import { DICTS } from "../i18n";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { GradingPanel } from "./GradingPanel";
import {
  makeEntry,
  makeEvaluationDetail,
  makeGrading,
  makeQueue,
  makeSteps,
} from "../test/grading-fixtures";

/*
 * Issue #108: no step card beside the answers. What it said — the step's
 * type, points and answers — is in the step header, on the counter's line,
 * and re-grading is offered on every answer, beside the question's title,
 * whichever way the evaluation is walked.
 */

const EVAL = "/app/api/evaluations/e1";
const BY_QUESTION = (itemId: string) => `${EVAL}/grading?by=question&itemId=${itemId}&anonymous=1`;
const BY_STUDENT = (attemptId: string) =>
  `${EVAL}/grading?by=student&attemptId=${attemptId}&anonymous=1`;
const en = DICTS.en;

const ENTRIES: GradingEntry[] = [
  makeEntry({ attemptId: "a1", label: "Amber Lynx" }),
  makeEntry({
    attemptId: "a2",
    label: "Bold Raven",
    grading: makeGrading({ id: "g2", attemptId: "a2", state: "validated", points: 0 }),
  }),
];

/** The one student's copy: both questions, 2 of 2 and 1 of 3 points. */
const COPY: GradingEntry[] = [
  makeEntry({ attemptId: "a1", itemId: "i1", label: "Amber Lynx" }),
  makeEntry({
    attemptId: "a1",
    itemId: "i2",
    label: "Amber Lynx",
    grading: makeGrading({ id: "g5", itemId: "i2", points: 1, maxPoints: 3 }),
  }),
];

function setup() {
  const stubs = mockFetch({
    [`GET ${EVAL}`]: ok(makeEvaluationDetail()),
    [`GET ${BY_QUESTION("i1")}`]: ok(makeQueue(ENTRIES)),
    [`GET ${BY_STUDENT("a1")}`]: ok(makeQueue(COPY)),
    [`GET ${EVAL}/grading/steps?by=question&anonymous=1`]: ok(
      makeSteps("question", [{ key: "i1", proposed: 1, validated: 1 }, { key: "i2" }]),
    ),
    [`GET ${EVAL}/grading/steps?by=student&anonymous=1`]: ok(
      makeSteps("student", [{ key: "a1", label: "Amber Lynx", proposed: 2 }]),
    ),
    [`GET ${EVAL}/grading/progress`]: ok({
      done: 4,
      total: 4,
      pending: { runner: 0, llm: 0 },
      failed: 0,
    }),
    [`GET ${EVAL}/results/by-question`]: ok([]),
    [`GET ${EVAL}/items/i1/versions`]: ok({ frozenNumber: 1, versions: [] }),
    [`GET ${EVAL}/items/i2/versions`]: ok({ frozenNumber: 1, versions: [] }),
  });
  renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
  return stubs;
}

const header = () => screen.getByRole("region", { name: en["grading.progress.title"] });
const detail = () => screen.getByRole("region", { name: en["grading.detail.label"] });
const findDetail = () => screen.findByRole("region", { name: en["grading.detail.label"] });

beforeEach(() => {
  vi.stubGlobal("EventSource", undefined);
});

describe("GradingPanel — the step header carries the step (#108)", () => {
  it("draws no step card: the side column holds the answer list alone", async () => {
    setup();
    await screen.findByText("Question 1 of 2");
    await within(await findDetail()).findByText("Amber Lynx");
    const aside = screen.getByRole("complementary", { name: en["aside.gradingItem"] });
    expect(within(aside).getByRole("list", { name: en["grading.list.label"] })).toBeInTheDocument();
    // The card's own words are gone from the column.
    expect(within(aside).queryByText("Multiple choice")).toBeNull();
    expect(within(aside).queryByText("2 pts")).toBeNull();
    expect(within(aside).queryByRole("button", { name: /Re-grade/ })).toBeNull();
  });

  it("puts the question's type, points and answers on the counter's line", async () => {
    setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(within(header()).getByText("2 answers")).toBeVisible());
    expect(within(header()).getByText("Multiple choice")).toBeVisible();
    expect(within(header()).getByText("2 pts")).toBeVisible();
  });

  it("by student, puts the answers and the student's running total there instead", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await user.click(screen.getByRole("radio", { name: "By student" }));
    await screen.findByText("Student 1 of 1");
    await waitFor(() => expect(within(header()).getByText("Total 3 / 5 pts")).toBeVisible());
    expect(within(header()).getByText("2 answers")).toBeVisible();
    // A question's points mean nothing across a whole copy.
    expect(within(header()).queryByText("2 pts")).toBeNull();
  });

  it("drops the student's total while the state filter hides part of the copy", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await user.click(screen.getByRole("radio", { name: "By student" }));
    await waitFor(() => expect(within(header()).getByText("Total 3 / 5 pts")).toBeVisible());
    await user.click(screen.getByRole("radio", { name: en["grading.filter.proposed"] }));
    await waitFor(() => expect(within(header()).queryByText(/^Total/)).toBeNull());
  });
});

describe("GradingPanel — re-grading from the answer (#108)", () => {
  it("offers it beside the question's title, with a tooltip that says what it does", async () => {
    setup();
    await within(await findDetail()).findByText("Amber Lynx");
    const title = within(detail()).getByRole("heading", { name: "1. sizeof-ptr" });
    const button = within(detail()).getByRole("button", { name: en["grading.regrade.open"] });
    expect(title.parentElement).toContainElement(button);
    expect(button).toHaveAccessibleDescription(en["grading.regrade.tip"]!);
  });

  it("opens the re-grade sheet of the question, by question", async () => {
    const user = userEvent.setup();
    setup();
    await within(await findDetail()).findByText("Amber Lynx");
    await user.click(within(detail()).getByRole("button", { name: en["grading.regrade.open"] }));
    const sheet = await screen.findByRole("dialog", { name: en["grading.regrade.title"] });
    expect(within(sheet).getByText("1. sizeof-ptr")).toBeVisible();
  });

  it("opens it by student too, on the question of the open answer", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await user.click(screen.getByRole("radio", { name: "By student" }));
    await screen.findByText("Student 1 of 1");
    // Open the second question of the copy, then re-grade it.
    await user.click(await screen.findByRole("button", { name: /^2\. array-decay, / }));
    await within(detail()).findByRole("heading", { name: "2. array-decay" });
    // By student the title also says what the question is.
    expect(within(detail()).getByText("3 pts")).toBeVisible();
    await user.click(within(detail()).getByRole("button", { name: en["grading.regrade.open"] }));
    const sheet = await screen.findByRole("dialog", { name: en["grading.regrade.title"] });
    expect(within(sheet).getByText("2. array-decay")).toBeVisible();
  });
});
