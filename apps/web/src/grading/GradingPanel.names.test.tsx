import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DICTS } from "../i18n";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { GradingPanel } from "./GradingPanel";
import { makeEntry, makeEvaluationDetail, makeQueue, makeSteps } from "../test/grading-fixtures";

/*
 * Issue #119: "Show names" showed no name. The server did send them, but by
 * student — the order a teacher reading whole copies uses — the only place
 * a student's label was drawn was inside the closed step picker: the step
 * counter said "Student 1 of 2", the rows and the answer named questions.
 *
 * Pinned here: the switch is a REQUEST (`anonymous=0`), and what it brings
 * back is on screen wherever a student is named — the list, the step
 * header, the picker and the header of the open answer — with the question
 * (number and title) always beside it, in both orders.
 */

const EVAL = "/app/api/evaluations/e1";
const en = DICTS.en;

const PSEUDONYMS = { a1: "Amber Lynx", a2: "Bold Raven" } as const;
const NAMES = { a1: "Ada Lovelace", a2: "Alan Turing" } as const;

function routesFor(anonymous: "0" | "1") {
  const who = anonymous === "1" ? PSEUDONYMS : NAMES;
  const entry = (attemptId: "a1" | "a2", itemId = "i1") =>
    makeEntry({ attemptId, itemId, label: who[attemptId] });
  return {
    [`GET ${EVAL}/grading?by=question&itemId=i1&anonymous=${anonymous}`]: ok(
      makeQueue([entry("a1"), entry("a2")]),
    ),
    [`GET ${EVAL}/grading?by=student&attemptId=a1&anonymous=${anonymous}`]: ok(
      makeQueue([entry("a1", "i1"), entry("a1", "i2")]),
    ),
    [`GET ${EVAL}/grading/steps?by=question&anonymous=${anonymous}`]: ok(
      makeSteps("question", [{ key: "i1", validated: 2 }, { key: "i2" }]),
    ),
    [`GET ${EVAL}/grading/steps?by=student&anonymous=${anonymous}`]: ok(
      makeSteps("student", [
        { key: "a1", label: who.a1, validated: 2 },
        { key: "a2", label: who.a2, validated: 2 },
      ]),
    ),
  };
}

function setup() {
  const stubs = mockFetch({
    [`GET ${EVAL}`]: ok(makeEvaluationDetail()),
    ...routesFor("1"),
    ...routesFor("0"),
    [`GET ${EVAL}/grading/progress`]: ok({
      done: 4,
      total: 4,
      pending: { runner: 0, llm: 0 },
      failed: 0,
    }),
    [`GET ${EVAL}/results/by-question`]: ok([]),
  });
  renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
  return stubs;
}

const detailHeader = () =>
  screen.getByRole("region", { name: en["grading.detail.label"] }).querySelector("header")!;
const stepHeader = () => screen.getByRole("region", { name: en["grading.progress.title"] });
const list = () => screen.getByRole("list", { name: en["grading.list.label"] });
const showNames = () => screen.getByRole("switch", { name: en["grading.showNames"] });

beforeEach(() => {
  vi.stubGlobal("EventSource", undefined);
});

describe("GradingPanel — show names (#119)", () => {
  it("by question: the names replace the pseudonyms in the list and the answer's header", async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    await within(await screen.findByRole("region", { name: en["grading.detail.label"] })).findByText(
      "Amber Lynx",
    );
    // The answer's header names the student AND the question, number and title.
    expect(within(detailHeader()).getByText("Amber Lynx")).toBeVisible();
    expect(within(detailHeader()).getByText("1. sizeof-ptr")).toBeVisible();
    expect(screen.queryByText("Ada Lovelace")).toBeNull();

    await user.click(showNames());

    await waitFor(() => expect(within(detailHeader()).getByText("Ada Lovelace")).toBeVisible());
    expect(within(detailHeader()).getByText("1. sizeof-ptr")).toBeVisible();
    expect(within(list()).getByText("Ada Lovelace")).toBeVisible();
    expect(within(list()).getByText("Alan Turing")).toBeVisible();
    expect(screen.queryByText("Amber Lynx")).toBeNull();
    // The names are asked for, never unmasked on the client (F-GRADE-03).
    expect(calls.map((c) => c.url)).toContain(`${EVAL}/grading?by=question&itemId=i1&anonymous=0`);
    // By question the step line keeps naming the question.
    expect(within(stepHeader()).getByText("Question 1 of 2")).toBeVisible();
  });

  it("by student: the step line, the picker and the answer's header name the student", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await user.click(screen.getByRole("radio", { name: "By student" }));

    // Hidden: the pseudonym, beside the counter and on the answer.
    expect(await within(stepHeader()).findByText("Amber Lynx")).toBeVisible();
    expect(within(stepHeader()).getByText("Student 1 of 2")).toBeVisible();
    await waitFor(() => expect(within(detailHeader()).getByText("Amber Lynx")).toBeVisible());
    expect(within(detailHeader()).getByText("1. sizeof-ptr")).toBeVisible();

    await user.click(showNames());

    expect(await within(stepHeader()).findByText("Ada Lovelace")).toBeVisible();
    expect(within(stepHeader()).getByText("Student 1 of 2")).toBeVisible();
    await waitFor(() => expect(within(detailHeader()).getByText("Ada Lovelace")).toBeVisible());
    expect(within(detailHeader()).getByText("1. sizeof-ptr")).toBeVisible();
    expect(screen.queryByText("Amber Lynx")).toBeNull();

    // The picker lists every student by name.
    await user.click(within(stepHeader()).getByRole("button", { name: /Student 1 of 2/ }));
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByText("Ada Lovelace")).toBeVisible();
    expect(within(listbox).getByText("Alan Turing")).toBeVisible();
    expect(within(listbox).queryByText("Bold Raven")).toBeNull();
  });
});
