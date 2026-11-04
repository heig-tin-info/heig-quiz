import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { EVAL, I1, ITEMS_URL, makePaper, PAPER_URL, USER } from "./paper.fixtures";
import { PaperEntryPage } from "./PaperEntryPage";
import { paperDraftKey } from "./usePaperSession";

/*
 * `/evaluations/:id/paper/new` (ADR-125 §9): the student's own player under
 * the paper's strip, the answers kept in the tab, ONE call at the end — the
 * paper route, with the student, the exam date and every answer.
 */
const ROUTE = `/evaluations/${EVAL}/paper/new?user=${USER}&date=2026-11-01`;
const CREATED = { attemptId: "cccccccc-0000-4000-8000-000000000001", supersededAttemptId: null };

describe("PaperEntryPage", () => {
  it("types the copy in the player and hands it in through the paper route", async () => {
    const user = userEvent.setup();
    sessionStorage.clear();
    const navigate = vi.fn();
    const { calls } = mockFetch({
      [`GET ${ITEMS_URL}`]: ok(makePaper()),
      [`POST ${PAPER_URL}`]: ok(CREATED),
    });
    renderWithProviders(<PaperEntryPage evaluationId={EVAL} navigate={navigate} />, { route: ROUTE });

    expect(await screen.findByRole("region", { name: "Paper copy of Nadia Roux" })).toBeInTheDocument();
    await user.click(await screen.findByRole("radio", { name: "&x" }));
    // Kept in the tab, keyed on the evaluation and the student.
    expect(JSON.parse(sessionStorage.getItem(paperDraftKey(EVAL, USER))!)).toEqual({ [I1]: { selected: [1] } });
    // Free navigation on paper, whatever the exam's: Next, not "Validate and continue".
    expect(screen.queryByRole("button", { name: /Validate/ })).toBeNull();

    // The expected answer of the question on screen, one button away.
    await user.click(screen.getByRole("button", { name: "Expected answer" }));
    expect(await screen.findByRole("dialog", { name: "Expected answer" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Hand in the copy" }));
    const dialog = await screen.findByRole("dialog", { name: "Hand in the copy" });
    await user.click(within(dialog).getByRole("button", { name: "Hand in the copy" }));

    // The copy in the results, where its scan is attached.
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        { view: "results", evaluationId: EVAL },
        { replace: true, query: { copy: CREATED.attemptId } },
      ),
    );
    expect(calls.find((c) => c.method === "POST")).toMatchObject({
      url: PAPER_URL,
      body: { userId: USER, examDate: "2026-11-01", answers: { [I1]: { selected: [1] } }, coordinates: "position" },
    });
    // The draft is gone.
    expect(sessionStorage.getItem(paperDraftKey(EVAL, USER))).toBeNull();
  });

  it("restores the draft of the tab", async () => {
    sessionStorage.setItem(paperDraftKey(EVAL, USER), JSON.stringify({ [I1]: { selected: [1] } }));
    mockFetch({ [`GET ${ITEMS_URL}`]: ok(makePaper()) });
    renderWithProviders(<PaperEntryPage evaluationId={EVAL} navigate={() => {}} />, { route: ROUTE });
    expect(await screen.findByRole("radio", { name: "&x" })).toBeChecked();
  });

  it("says a refused copy, and keeps the answers", async () => {
    const user = userEvent.setup();
    sessionStorage.clear();
    mockFetch({
      [`GET ${ITEMS_URL}`]: ok(makePaper()),
      [`POST ${PAPER_URL}`]: fail(422, { error: "answer_invalid" }),
    });
    renderWithProviders(<PaperEntryPage evaluationId={EVAL} navigate={() => {}} />, { route: ROUTE });
    await user.click(await screen.findByRole("radio", { name: "&x" }));
    await user.click(screen.getByRole("button", { name: "Hand in the copy" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Hand in the copy" }));
    expect(
      await screen.findByText("An answer could not be read. Check the copy and hand it in again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "&x" })).toBeChecked();
  });

  it("says why the paper is refused", async () => {
    mockFetch({ [`GET ${ITEMS_URL}`]: fail(422, { error: "paper_no_seat" }) });
    renderWithProviders(<PaperEntryPage evaluationId={EVAL} navigate={() => {}} />, { route: ROUTE });
    expect(
      await screen.findByText("This person is not enrolled in the classroom."),
    ).toBeInTheDocument();
  });
});
