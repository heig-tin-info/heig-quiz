import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeEvaluationDetail } from "../test/live-fixtures";
import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { EVAL, ITEMS_URL, makePaper, USER } from "./paper.fixtures";
import { PaperEntryDialog } from "./PaperEntryDialog";

/*
 * "Enter a paper copy" (ADR-125 §17): the row's student, the exam date
 * offered from the server's default, the warning of a replaced attempt, the
 * server's refusal said before anything is typed; where the paper has
 * several variants, the copy's asked first (ADR-148).
 */
const DETAIL = `GET /app/api/evaluations/${EVAL}`;
const detail = (count: number) =>
  ok(makeEvaluationDetail({ exports: { document: null, handout: null, paper: null, variants: { count, varies: true, locked: true } } }));
function open(onStart = vi.fn()) {
  renderWithProviders(
    <PaperEntryDialog evaluationId={EVAL} userId={USER} name="Nadia Roux" onClose={() => {}} onStart={onStart} />,
  );
  return onStart;
}

describe("PaperEntryDialog", () => {
  it("offers the opening day, and starts the entry with the date chosen", async () => {
    const user = userEvent.setup();
    mockFetch({ [DETAIL]: detail(1), [`GET ${ITEMS_URL}`]: ok(makePaper()) });
    const onStart = open();
    const dialog = await screen.findByRole("dialog", { name: "Paper copy of Nadia Roux" });
    const date = await within(dialog).findByLabelText("Exam date");
    expect(date).toHaveValue("2026-11-02");
    // No attempt to replace: no warning.
    expect(within(dialog).queryByText(/will be replaced/)).toBeNull();
    await user.clear(date);
    await user.type(date, "2026-11-03");
    await user.click(within(dialog).getByRole("button", { name: "Start the entry" }));
    expect(onStart).toHaveBeenCalledWith("2026-11-03", 1);
    // One variant: none to name.
    expect(within(dialog).queryByLabelText("Variant of the copy")).toBeNull();
  });

  it("says that the student's attempt will be replaced", async () => {
    mockFetch({
      [DETAIL]: detail(1),
      [`GET ${ITEMS_URL}`]: ok(
        makePaper({ replaces: { attemptId: "bbbbbbbb-0000-4000-8000-000000000001", state: "in_progress", origin: "digital" } }),
      ),
    });
    open();
    expect(
      await screen.findByText("The current attempt of Nadia Roux will be replaced and count nowhere."),
    ).toBeInTheDocument();
  });

  it("says the server's refusal, and offers nothing to start", async () => {
    mockFetch({ [DETAIL]: detail(1), [`GET ${ITEMS_URL}`]: fail(409, { error: "not_printable", reason: "type", types: ["code"] }) });
    open();
    expect(await screen.findByText("This exam has a question that does not print.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start the entry" })).toBeDisabled();
  });

  it("asks the copy's variant first where the paper has several, and reads that variant's paper", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      [DETAIL]: detail(3),
      [`GET ${ITEMS_URL}&variant=2`]: ok(makePaper({ variant: 2 })),
    });
    const onStart = open();
    const dialog = await screen.findByRole("dialog", { name: "Paper copy of Nadia Roux" });
    const select = await within(dialog).findByLabelText("Variant of the copy");
    // No paper read, nothing to start, before the variant is named.
    expect(within(dialog).getByRole("button", { name: "Start the entry" })).toBeDisabled();
    expect(calls.some((c) => c.url.includes("/paper/items"))).toBe(false);
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose", "Variant A", "Variant B", "Variant C"]);
    await user.selectOptions(select, "2");
    await within(dialog).findByLabelText("Exam date");
    await user.click(within(dialog).getByRole("button", { name: "Start the entry" }));
    expect(onStart).toHaveBeenCalledWith("2026-11-02", 2);
  });
});
