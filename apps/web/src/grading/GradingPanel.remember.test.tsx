import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DICTS } from "../i18n";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { GradingPanel } from "./GradingPanel";
import {
  makeEntry,
  makeEvaluationDetail,
  makeQueue,
  makeSteps,
} from "../test/grading-fixtures";
import { GRADING_VIEW_KEY } from "./view";

/*
 * Issue #110: the order, the filters and the parts shown come back on the
 * next visit; the names switch does not (F-GRADE-03). A visit is a mount
 * of the panel, and the storage is the jsdom one, cleared between tests.
 */

const EVAL = "/app/api/evaluations/e1";
const en = DICTS.en;

function routes() {
  const entry = makeEntry({ attemptId: "a1", label: "Amber Lynx" });
  return {
    [`GET ${EVAL}`]: ok(makeEvaluationDetail()),
    [`GET ${EVAL}/grading?by=question&itemId=i1&anonymous=1`]: ok(makeQueue([entry])),
    [`GET ${EVAL}/grading?by=question&itemId=i1&anonymous=0`]: ok(
      makeQueue([makeEntry({ label: "Marie Rochat" })]),
    ),
    [`GET ${EVAL}/grading?by=question&itemId=i1&anonymous=1&state=proposed`]: ok(makeQueue([entry])),
    [`GET ${EVAL}/grading?by=question&itemId=i1&anonymous=0&state=proposed`]: ok(
      makeQueue([makeEntry({ label: "Marie Rochat" })]),
    ),
    [`GET ${EVAL}/grading?by=student&attemptId=a1&anonymous=1&state=proposed`]: ok(makeQueue([entry])),
    [`GET ${EVAL}/grading?by=student&attemptId=a1&anonymous=1`]: ok(makeQueue([entry])),
    [`GET ${EVAL}/grading/steps?by=question&anonymous=1`]: ok(
      makeSteps("question", [{ key: "i1", proposed: 1 }, { key: "i2" }]),
    ),
    [`GET ${EVAL}/grading/steps?by=question&anonymous=0`]: ok(
      makeSteps("question", [{ key: "i1", proposed: 1 }, { key: "i2" }]),
    ),
    [`GET ${EVAL}/grading/steps?by=student&anonymous=1`]: ok(
      makeSteps("student", [{ key: "a1", label: "Amber Lynx", proposed: 1 }]),
    ),
    [`GET ${EVAL}/grading/progress`]: ok({
      done: 1,
      total: 1,
      pending: { runner: 0, llm: 0 },
      failed: 0,
    }),
    [`GET ${EVAL}/results/by-question`]: ok([]),
  } as Parameters<typeof mockFetch>[0];
}

/** One visit: the panel mounted afresh, as a navigation back to it does. */
function visit() {
  mockFetch(routes());
  return renderWithProviders(<GradingPanel evaluationId="e1" navigate={vi.fn()} />);
}

beforeEach(() => {
  vi.stubGlobal("EventSource", undefined);
});

describe("GradingPanel — remembered across visits (#110)", () => {
  it("comes back with the order, the filters and the parts chosen last time", async () => {
    const user = userEvent.setup();
    const first = visit();
    await screen.findByText("Question 1 of 2");
    await user.click(screen.getByRole("radio", { name: "By student" }));
    await screen.findByText("Student 1 of 1");
    await user.click(screen.getByRole("radio", { name: en["grading.filter.proposed"] }));
    await user.selectOptions(screen.getByLabelText("Graded by"), "llm");
    await user.selectOptions(screen.getByLabelText("Confidence"), "low");
    await user.click(screen.getByRole("button", { name: en["grading.parts.open"] }));
    const menu = await screen.findByRole("dialog", { name: en["grading.parts.label"] });
    await user.click(within(menu).getByRole("checkbox", { name: en["grading.parts.prompt"] }));
    first.unmount();

    visit();
    expect(await screen.findByText("Student 1 of 1")).toBeVisible();
    expect(screen.getByRole("radio", { name: "By student" })).toBeChecked();
    expect(screen.getByRole("radio", { name: en["grading.filter.proposed"] })).toBeChecked();
    expect(screen.getByLabelText("Graded by")).toHaveValue("llm");
    expect(screen.getByLabelText("Confidence")).toHaveValue("low");
    expect(screen.getByRole("button", { name: "Show 4/5" })).toBeInTheDocument();
  });

  it("opens on the defaults when the stored value is malformed", async () => {
    localStorage.setItem(GRADING_VIEW_KEY, "{broken");
    visit();
    expect(await screen.findByText("Question 1 of 2")).toBeVisible();
    expect(screen.getByRole("radio", { name: "By question" })).toBeChecked();
    expect(screen.getByRole("radio", { name: en["grading.filter.all"] })).toBeChecked();
    expect(screen.getByRole("button", { name: en["grading.parts.open"] })).toBeInTheDocument();
  });

  it("never remembers the names: they are hidden again on the next visit", async () => {
    const user = userEvent.setup();
    const first = visit();
    await screen.findByText("Question 1 of 2");
    // Something else changes too, so the view IS written this visit.
    await user.click(screen.getByRole("radio", { name: en["grading.filter.proposed"] }));
    await user.click(screen.getByRole("switch", { name: en["grading.showNames"] }));
    expect((await screen.findAllByText("Marie Rochat"))[0]).toBeVisible();
    await waitFor(() => expect(localStorage.getItem(GRADING_VIEW_KEY)).not.toBeNull());
    expect(Object.keys(JSON.parse(localStorage.getItem(GRADING_VIEW_KEY)!)).sort()).toEqual(
      ["confidence", "order", "parts", "source", "stateFilter"],
    );
    first.unmount();

    // Even a stored value claiming the names were on is ignored.
    localStorage.setItem(
      GRADING_VIEW_KEY,
      JSON.stringify({ ...JSON.parse(localStorage.getItem(GRADING_VIEW_KEY)!), showNames: true }),
    );
    visit();
    await screen.findByText("Question 1 of 2");
    expect(screen.getByRole("switch", { name: en["grading.showNames"] })).not.toBeChecked();
    expect((await screen.findAllByText("Amber Lynx")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Marie Rochat")).toBeNull();
  });
});
