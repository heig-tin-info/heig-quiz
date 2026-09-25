import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { GradingQueueItem, ItemVersions, VersionRow } from "@quiz/contracts";

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
const VERSIONS = "/app/api/evaluations/e1/items/i1/versions";

const version = (number: number, changeNote: string | null, deprecated = false): VersionRow => ({
  number,
  publishedAt: `2026-09-0${number}T08:00:00.000Z`,
  publishedBy: null,
  changeNote,
  deprecatedAt: deprecated ? "2026-09-09T08:00:00.000Z" : null,
  deprecationNote: deprecated ? "wrong" : null,
});

/** Frozen on v2; v3 is the fix published since. Newest first, as the API sends. */
const FIXED: ItemVersions = {
  frozenNumber: 2,
  versions: [version(3, "Fixed the correct choice."), version(2, "Reworded."), version(1, null)],
};

function setup(
  over: Record<string, ReturnType<typeof ok>> = {},
  onClose = vi.fn(),
  versions: ItemVersions = FIXED,
) {
  const queryClient = makeQueryClient();
  const stubs = mockFetch({ [`GET ${VERSIONS}`]: ok(versions), ...over });
  const rendered = renderWithProviders(
    <RegradeSheet evaluationId="e1" item={ITEM} onClose={onClose} />,
    { queryClient },
  );
  return {
    ...rendered,
    ...stubs,
    /** The version list is a read; what these tests count is what the sheet SENDS. */
    get sent() {
      return stubs.calls.filter((c) => c.method !== "GET");
    },
    onClose,
    queryClient,
  };
}

const radio = (name: RegExp) => screen.findByRole("radio", { name });

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
    const ctx = setup();
    await radio(/v3/);
    await userEvent.click(action());
    expect(await screen.findByText("A note is required.")).toBeVisible();
    expect(noteField()).toHaveAttribute("aria-invalid", "true");
    expect(ctx.sent).toHaveLength(0);
  });

  it("treats a note of nothing but spaces as no note at all", async () => {
    const ctx = setup();
    await radio(/v3/);
    await userEvent.type(noteField(), "   ");
    await userEvent.click(action());
    expect(await screen.findByText("A note is required.")).toBeVisible();
    expect(ctx.sent).toHaveLength(0);
  });

  it("stays quiet about the note until the teacher has tried once", async () => {
    setup();
    expect(screen.queryByText("A note is required.")).toBeNull();
    // Focusing and leaving the empty field is not a failed submission.
    await userEvent.click(noteField());
    await userEvent.tab();
    expect(screen.queryByText("A note is required.")).toBeNull();
  });

  it("lists the versions newest first, with their notes and markers", async () => {
    setup({}, vi.fn(), {
      frozenNumber: 1,
      versions: [version(2, "Fixed.", true), version(1, null)],
    });
    const radios = await screen.findAllByRole("radio");
    expect(radios.map((r) => r.closest("label")!.textContent)).toEqual([
      expect.stringMatching(/^v2deprecated.*Fixed\.$/),
      expect.stringMatching(/^v1frozen by the evaluation.*No change note\.$/),
    ]);
    expect(
      screen.getByRole("group", { name: "Question version to grade against" }),
    ).toHaveAccessibleDescription("By default, the version frozen by the evaluation.");
  });

  it("preselects the newest version when it is newer than the frozen one, and sends it", async () => {
    const onClose = vi.fn();
    const ctx = setup({ [`POST ${REGRADE}`]: ok({ queued: 12 }) }, onClose);
    expect(await radio(/v3/)).toBeChecked();
    expect(screen.getByRole("radio", { name: /v2/ })).not.toBeChecked();

    await userEvent.type(noteField(), "  Fixed the key.  ");
    await userEvent.click(action());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ctx.sent[0]).toMatchObject({
      url: REGRADE,
      method: "POST",
      body: { note: "Fixed the key.", toVersionNumber: 3 },
    });
  });

  it("keeps the frozen version when nothing newer exists, and sends no version", async () => {
    const ctx = setup({ [`POST ${REGRADE}`]: ok({ queued: 12 }) }, vi.fn(), {
      frozenNumber: 2,
      versions: [version(2, "Reworded."), version(1, null)],
    });
    expect(await radio(/v2/)).toBeChecked();

    await userEvent.type(noteField(), "Typo in the expected output.");
    await userEvent.click(action());

    await waitFor(() => expect(ctx.sent).toHaveLength(1));
    // No `toVersionNumber` key at all: an absent field keeps the version
    // the evaluation froze, and `null` would be a different request.
    expect(ctx.sent[0]!.body).toEqual({ note: "Typo in the expected output." });
  });

  it("does not preselect a deprecated version", async () => {
    setup({}, vi.fn(), {
      frozenNumber: 1,
      versions: [version(2, "Broken.", true), version(1, null)],
    });
    expect(await radio(/v1/)).toBeChecked();
  });

  it("sends the version the teacher picks", async () => {
    const ctx = setup({ [`POST ${REGRADE}`]: ok({ queued: 12 }) });
    await userEvent.click(await radio(/v1/));
    await userEvent.type(noteField(), "Back to the original.");
    await userEvent.click(action());

    await waitFor(() => expect(ctx.sent).toHaveLength(1));
    expect(ctx.sent[0]!.body).toEqual({ note: "Back to the original.", toVersionNumber: 1 });
  });

  it("says so when the versions cannot be loaded", async () => {
    setup({ [`GET ${VERSIONS}`]: { status: 500, body: {} } });
    expect(
      await screen.findByText("The versions of this question could not be loaded."),
    ).toBeVisible();
  });

  it("invalidates the grading and the results of this evaluation, and nothing else", async () => {
    const { queryClient } = setup({ [`POST ${REGRADE}`]: ok({ queued: 12 }) });
    await radio(/v3/);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await userEvent.type(noteField(), "Regraded.");
    await userEvent.click(action());

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["grading", "e1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["results", "e1"] });
  });

  it("tells the teacher the pass has started", async () => {
    setup({ [`POST ${REGRADE}`]: ok({ queued: 12 }) });
    await radio(/v3/);
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

    await radio(/v3/);
    await userEvent.type(noteField(), "Regraded.");
    await userEvent.click(action());

    expect(await screen.findByText("The results are already released.")).toBeVisible();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Cancel without asking the server anything", async () => {
    const onClose = vi.fn();
    const ctx = setup({}, onClose);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(ctx.sent).toHaveLength(0);
  });
});
