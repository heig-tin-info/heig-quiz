import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { CourseDocument, CourseLibrary, EvaluationDetail } from "@quiz/contracts";

import { Harness, open, PATCH, withMode } from "../test/advancedDisclosure";
import { mockFetch, ok, renderWithProviders } from "../test/render";

/* ADR-144 §7: the documents an evaluation provides, beside the calculator and the notepad. */

const config = { "GET /app/api/config": ok({ devLogin: false, kiosk: null }) };

const document = (n: number, kind: CourseDocument["kind"] = "pdf"): CourseDocument => ({
  id: `0190d3c4-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`,
  title: `Sheet ${n}`,
  filename: `sheet-${n}.pdf`,
  kind,
  bytes: 1000,
  uploadedAt: "2026-11-20T10:00:00.000Z",
  uploadedBy: { id: "0190d3c4-0000-7000-8000-0000000000a1", name: "Ada Teacher" },
  warnings: [],
  missing: false,
  canDelete: true,
  usedBy: [],
});
const libraryOf = (documents: CourseDocument[]): CourseLibrary => ({ documents, usedBytes: 0, quotaBytes: 1e8 });
const provided = (d: CourseDocument) => ({ id: d.id, title: d.title, kind: d.kind });

const withDocuments = (detail: EvaluationDetail, documents: CourseDocument[]): EvaluationDetail => ({
  ...detail,
  documents: documents.map(provided),
});

function world(detail: EvaluationDetail, library: CourseDocument[], patched = detail) {
  return mockFetch({
    ...config,
    [`GET /app/api/courses/${detail.courseId}/documents`]: ok(libraryOf(library)),
    [PATCH]: ok(patched),
  });
}

describe("the Documents provided setting", () => {
  it("names the selection in its order, and saves what is ticked in the order ticked", async () => {
    const [a, b, c] = [document(1), document(2, "markdown"), document(3)];
    const detail = withDocuments(withMode("exam"), [b!]);
    const { calls } = world(detail, [a!, b!, c!]);
    renderWithProviders(<Harness detail={detail} />);
    await open();
    expect(screen.getByText("Sheet 2")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Choose" }));
    const dialog = await screen.findByRole("dialog", { name: "Documents provided" });
    expect(within(dialog).getByText(/At most 10/)).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: /Sheet 2/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Sheet 3/ }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Sheet 1/ }));
    expect(within(dialog).getByLabelText("Position 3")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ documents: [b!.id, c!.id, a!.id] }),
    );
  });

  it("disables a box past the tenth, never refuses it after the click", async () => {
    const library = Array.from({ length: 11 }, (_, i) => document(i + 1));
    const detail = withDocuments(withMode("exercise"), library.slice(0, 10));
    world(detail, library);
    renderWithProviders(<Harness detail={detail} />);
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Choose" }));
    const dialog = await screen.findByRole("dialog", { name: "Documents provided" });
    expect(within(dialog).getByRole("checkbox", { name: /Sheet 11/ })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /^Sheet 1(?!\d)/ }));
    expect(within(dialog).getByRole("checkbox", { name: /Sheet 11/ })).toBeEnabled();
  });

  it("is frozen with the other settings", async () => {
    const detail = withMode("exam");
    world(detail, [document(1)]);
    renderWithProviders(<Harness detail={detail} disabled />);
    await open();
    expect(screen.getByText("No document on screen.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Choose" })).toBeDisabled();
  });

  it("leads to the Documents tab when the course's library is empty", async () => {
    const detail = withMode("exam");
    world(detail, []);
    renderWithProviders(<Harness detail={detail} />);
    await open();
    const link = await screen.findByRole("link", { name: "Add one in the Documents tab" });
    expect(link).toHaveAttribute("href", `/courses/${detail.courseId}/documents`);
    expect(screen.queryByRole("button", { name: "Choose" })).toBeNull();
  });

  it("is not offered on a poll", async () => {
    const detail = withMode("poll");
    world(detail, [document(1)]);
    renderWithProviders(<Harness detail={detail} />);
    await open();
    expect(screen.queryByText("Documents provided")).toBeNull();
  });
});
