import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
 * Issue #109: the "Show" menu of the filter row puts parts of the open
 * answer away — the internal name, the prompt, the explanation, the
 * solution, the grading comment — one by one. The student's answer is never
 * one of them, and hiding the comment never takes Adjust away.
 */

const EVAL = "/app/api/evaluations/e1";
const en = DICTS.en;

/** Ticked choice 0 ("4") where the key is choice 1 ("8"): a miss to mark. */
const ENTRY = makeEntry({
  attemptId: "a1",
  label: "Amber Lynx",
  answer: { selected: [0] },
  grading: makeGrading({ points: 0, source: "manual", comment: "Think of LP64." }),
});

function setup() {
  mockFetch({
    [`GET ${EVAL}`]: ok(makeEvaluationDetail()),
    [`GET ${EVAL}/grading?by=question&itemId=i1&anonymous=1`]: ok(makeQueue([ENTRY])),
    [`GET ${EVAL}/grading/steps?by=question&anonymous=1`]: ok(
      makeSteps("question", [{ key: "i1", proposed: 1 }, { key: "i2" }]),
    ),
    [`GET ${EVAL}/grading/progress`]: ok({
      done: 1,
      total: 1,
      pending: { runner: 0, llm: 0 },
      failed: 0,
    }),
    [`GET ${EVAL}/results/by-question`]: ok([
      { item: { id: "i1" }, explanation: "Pointers are 8 bytes on LP64." },
    ]),
  });
  renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
}

const detail = () => screen.getByRole("region", { name: en["grading.detail.label"] });

/** Waits for the whole answer: the review is lazy, the explanation a second read. */
async function ready() {
  const region = await screen.findByRole("region", { name: en["grading.detail.label"] });
  await within(region).findByText("Missed");
  await within(region).findByText("Pointers are 8 bytes on LP64.");
  return region;
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: en["grading.parts.open"] }));
  return screen.findByRole("dialog", { name: en["grading.parts.label"] });
}

/** The two choices, each with its text: they ARE the student's answer. */
function expectAnswer() {
  const d = detail();
  expect(within(d).getByText("4")).toBeInTheDocument();
  expect(within(d).getByText("8")).toBeInTheDocument();
  expect(within(d).getByText("Incorrect")).toBeInTheDocument();
}

beforeEach(() => {
  vi.stubGlobal("EventSource", undefined);
});

describe("GradingPanel — the parts of an answer shown (#109)", () => {
  it("shows every part by default", async () => {
    setup();
    const d = await ready();
    expect(within(d).getByRole("heading", { name: "1. sizeof-ptr" })).toBeVisible();
    expect(within(d).getByText(/on LP64\?/)).toBeInTheDocument();
    expect(within(d).getByText("Think of LP64.")).toBeVisible();
    expectAnswer();
  });

  it("lists the five parts, and the student's answer ticked for good", async () => {
    const user = userEvent.setup();
    setup();
    await ready();
    const menu = await openMenu(user);
    const answer = within(menu).getByRole("checkbox", { name: en["grading.parts.answer"] });
    expect(answer).toBeChecked();
    expect(answer).toBeDisabled();
    for (const key of [
      "grading.parts.internalName",
      "grading.parts.prompt",
      "grading.parts.explanation",
      "grading.parts.solution",
      "grading.parts.comment",
    ] as const) {
      expect(within(menu).getByRole("checkbox", { name: en[key] })).toBeChecked();
    }
  });

  it.each([
    ["grading.parts.internalName", () => within(detail()).queryByRole("heading", { name: "1. sizeof-ptr" })],
    ["grading.parts.prompt", () => within(detail()).queryByText(/on LP64\?/)],
    ["grading.parts.explanation", () => within(detail()).queryByText("Pointers are 8 bytes on LP64.")],
    ["grading.parts.solution", () => within(detail()).queryByText("Missed")],
    ["grading.parts.comment", () => within(detail()).queryByText("Think of LP64.")],
  ] as const)("hides %s, and nothing of the answer", async (key, find) => {
    const user = userEvent.setup();
    setup();
    await ready();
    expect(find()).not.toBeNull();
    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("checkbox", { name: en[key] }));
    await waitFor(() => expect(find()).toBeNull());
    expectAnswer();
    // The trigger says something is put away.
    expect(screen.getByRole("button", { name: "Show 4/5" })).toBeInTheDocument();
  });

  it("keeps the answer and Adjust when every part is hidden", async () => {
    const user = userEvent.setup();
    setup();
    await ready();
    const menu = await openMenu(user);
    for (const box of within(menu).getAllByRole("checkbox")) {
      if (!(box as HTMLInputElement).disabled) await user.click(box);
    }
    await waitFor(() => expect(within(detail()).queryByText("Think of LP64.")).toBeNull());
    expectAnswer();
    // Hiding the comment hides its display, never the way to write one.
    expect(within(detail()).getByRole("button", { name: en["grading.override"] })).toBeVisible();
    expect(within(detail()).getByRole("button", { name: en["grading.regrade.open"] })).toBeVisible();
  });
});
