import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { GradingQueueItem } from "@quiz/contracts";

import { makeQueryClient, mockFetch, ok, renderWithProviders } from "../test/render";
import { RegradeSheet } from "./RegradeSheet";

/*
 * F-GRADE-06: one question re-graded across every attempt.
 *
 * The note is what the history shows a month later, so the form refuses the
 * round trip without one — the same rule `OverrideSheet.test.tsx` pins for
 * the comment of F-GRADE-05. The two sheets are structurally identical today
 * (FF-20) and are meant to share a form helper; this file is what says what
 * the shared version still has to do.
 */

const ITEM: GradingQueueItem = {
  id: "i1",
  position: 0,
  internalName: "sizeof-ptr",
  type: "mcq",
  points: 2,
};

const REGRADE = "/app/api/evaluations/e1/items/i1/regrade";

function setup(over: Record<string, ReturnType<typeof ok>> = {}, onClose = vi.fn()) {
  const queryClient = makeQueryClient();
  const stubs = mockFetch(over);
  const rendered = renderWithProviders(
    <RegradeSheet evaluationId="e1" item={ITEM} onClose={onClose} />,
    { queryClient },
  );
  return { ...rendered, ...stubs, onClose, queryClient };
}

const noteField = () => screen.getByLabelText("Note, kept with every new grading");
const action = () => screen.getByRole("button", { name: "Re-grade" });

describe("RegradeSheet", () => {
  it("names the question it is about, numbered from one", async () => {
    setup();
    expect(await screen.findByRole("dialog")).toHaveAccessibleName("Re-grade a question");
    // `position` is 0-based on the wire; every screen numbers from 1.
    expect(screen.getByText("1. sizeof-ptr")).toBeVisible();
  });

  it("refuses to start without a note and says so on the field", async () => {
    const { calls } = setup();
    await userEvent.click(action());
    expect(await screen.findByText("A note is required.")).toBeVisible();
    expect(noteField()).toHaveAttribute("aria-invalid", "true");
    expect(calls).toHaveLength(0);
  });

  it("treats a note of nothing but spaces as no note at all", async () => {
    const { calls } = setup();
    await userEvent.type(noteField(), "   ");
    await userEvent.click(action());
    expect(await screen.findByText("A note is required.")).toBeVisible();
    expect(calls).toHaveLength(0);
  });

  it("stays quiet about the note until the teacher has tried once", async () => {
    setup();
    expect(screen.queryByText("A note is required.")).toBeNull();
    // Focusing and leaving the empty field is not a failed submission.
    await userEvent.click(noteField());
    await userEvent.tab();
    expect(screen.queryByText("A note is required.")).toBeNull();
  });

  it("posts the trimmed note, with no version, and closes", async () => {
    const onClose = vi.fn();
    const { calls } = setup({ [`POST ${REGRADE}`]: ok({ queued: 12 }) }, onClose);

    await userEvent.type(noteField(), "  Typo in the expected output.  ");
    await userEvent.click(action());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({
      url: REGRADE,
      method: "POST",
      // No `toVersionNumber` key at all: an absent field keeps the version
      // the evaluation froze, and `null` would be a different request.
      body: { note: "Typo in the expected output." },
    });
    expect(calls[0]!.body).not.toHaveProperty("toVersionNumber");
  });

  it("carries the target version as a number when one is typed", async () => {
    const { calls } = setup({ [`POST ${REGRADE}`]: ok({ queued: 12 }) });

    await userEvent.type(noteField(), "Published a fixed test case.");
    await userEvent.type(screen.getByLabelText("Published version"), "3");
    await userEvent.click(action());

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ note: "Published a fixed test case.", toVersionNumber: 3 });
  });

  it("invalidates the grading and the results of this evaluation, and nothing else", async () => {
    const { queryClient } = setup({ [`POST ${REGRADE}`]: ok({ queued: 12 }) });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await userEvent.type(noteField(), "Regraded.");
    await userEvent.click(action());

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["grading", "e1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["results", "e1"] });
  });

  it("tells the teacher the pass has started", async () => {
    setup({ [`POST ${REGRADE}`]: ok({ queued: 12 }) });
    await userEvent.type(noteField(), "Regraded.");
    await userEvent.click(action());
    expect(await screen.findByText("Re-grading started.")).toBeVisible();
  });

  it("keeps the sheet open and shows the server's message when the pass is refused", async () => {
    const onClose = vi.fn();
    setup(
      {
        [`POST ${REGRADE}`]: {
          status: 409,
          body: { message: "The results are already released." },
        },
      },
      onClose,
    );

    await userEvent.type(noteField(), "Regraded.");
    await userEvent.click(action());

    expect(await screen.findByText("The results are already released.")).toBeVisible();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Cancel without asking the server anything", async () => {
    const onClose = vi.fn();
    const { calls } = setup({}, onClose);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
