import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { OverrideSheet } from "./OverrideSheet";
import { makeEntry, makeGrading } from "../test/grading-fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";

/*
 * F-GRADE-05 makes the comment mandatory, and the form is what enforces it
 * before the round trip: a teacher who changes a grade owes the student a
 * reason, and finding that out from a 422 is finding it out too late.
 */

describe("OverrideSheet", () => {
  it("refuses to save without a comment and says so on the field", async () => {
    const { calls } = mockFetch({});
    renderWithProviders(
      <OverrideSheet evaluationId="e1" entry={makeEntry()} maxPoints={2} onClose={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save and validate" }));
    expect(await screen.findByText("A comment is required.")).toBeVisible();
    expect(calls).toHaveLength(0);
  });

  it("refuses points outside the question's scale", async () => {
    const { calls } = mockFetch({});
    renderWithProviders(
      <OverrideSheet evaluationId="e1" entry={makeEntry()} maxPoints={2} onClose={vi.fn()} />,
    );
    const points = screen.getByLabelText("Points");
    await userEvent.clear(points);
    await userEvent.type(points, "9");
    await userEvent.type(screen.getByLabelText(/Comment/), "Generous.");
    await userEvent.click(screen.getByRole("button", { name: "Save and validate" }));
    expect(await screen.findByText(/between 0 and 2/)).toBeVisible();
    expect(calls).toHaveLength(0);
  });

  it("posts the override on the grading and closes", async () => {
    const onClose = vi.fn();
    const { calls } = mockFetch({
      "POST /app/api/gradings/g1/override": ok(makeGrading({ state: "validated" })),
    });
    renderWithProviders(
      <OverrideSheet evaluationId="e1" entry={makeEntry()} maxPoints={2} onClose={onClose} />,
    );
    const points = screen.getByLabelText("Points");
    await userEvent.clear(points);
    await userEvent.type(points, "1.5");
    await userEvent.type(screen.getByLabelText(/Comment/), "Right idea, wrong unit.");
    await userEvent.click(screen.getByRole("button", { name: "Save and validate" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({
      url: "/app/api/gradings/g1/override",
      method: "POST",
      body: { points: 1.5, comment: "Right idea, wrong unit." },
    });
  });

  it("addresses a cell with no grading through its answer instead", async () => {
    const entry = makeEntry({ grading: null, answerId: "ans9" });
    const { calls } = mockFetch({ "POST /app/api/answers/ans9/gradings": ok(makeGrading()) });
    renderWithProviders(
      <OverrideSheet evaluationId="e1" entry={entry} maxPoints={2} onClose={vi.fn()} />,
    );
    await userEvent.type(screen.getByLabelText(/Comment/), "Graded by hand.");
    await userEvent.click(screen.getByRole("button", { name: "Save and validate" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe("/app/api/answers/ans9/gradings");
  });
});
