import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { CourseDocument, CourseLibrary } from "@quiz/contracts";

import { fail, mockFetch, noContent, ok, renderWithProviders, type Reply } from "../test/render";
import { Button } from "../ui";
import { CourseDocuments, useDocumentUploads } from "./CourseDocuments";

/*
 * The Documents tab of a course (F-ORG-18, ADR-144): its states — loading,
 * empty, failed, the list with what a Markdown rendering reported and a file
 * gone missing, the quota full — the uploads one after the other with the
 * refusals worded (type, size, quota), the rename, the delete offered to who
 * may, and the quota an administrator types in.
 */

const COURSE = "0190d3c4-0000-7000-8000-0000000000c1";
const URL_LIST = `/app/api/courses/${COURSE}/documents`;
const MIB = 1024 * 1024;

const pdf: CourseDocument = {
  id: "0190d3c4-0000-7000-8000-0000000000e1",
  title: "Datasheet",
  filename: "datasheet.pdf",
  kind: "pdf",
  bytes: 2 * MIB,
  uploadedAt: "2026-11-20T10:00:00.000Z",
  uploadedBy: { id: "0190d3c4-0000-7000-8000-0000000000a1", name: "Ada Teacher" },
  warnings: [],
  missing: false,
  canDelete: true,
};
const sheet: CourseDocument = {
  ...pdf,
  id: "0190d3c4-0000-7000-8000-0000000000e2",
  title: "Formula sheet",
  filename: "formulas.md",
  kind: "markdown",
  bytes: 12_000,
  warnings: [{ code: "raw_html" }, { code: "external_image", href: "https://example.org/a.png" }],
  canDelete: false,
};

const libraryOf = (documents: CourseDocument[], usedBytes = documents.reduce((s, d) => s + d.bytes, 0), quotaBytes = 100 * MIB): CourseLibrary => ({
  documents,
  usedBytes,
  quotaBytes,
});

function Harness() {
  const uploads = useDocumentUploads(COURSE);
  return (
    <>
      <Button onClick={uploads.pick}>Add a document</Button>
      {uploads.picker}
      <CourseDocuments courseId={COURSE} uploads={uploads} />
    </>
  );
}

function renderTab(library: Reply | (() => Reply), extra: Record<string, Reply | (() => Reply)> = {}) {
  const fetched = mockFetch({ [`GET ${URL_LIST}`]: library, ...extra });
  renderWithProviders(<Harness />);
  return fetched;
}

const picker = () => screen.getByTestId("document-picker") as HTMLInputElement;
const file = (name: string, size = 10) => new File([new Uint8Array(size)], name, { type: "application/octet-stream" });

describe("the Documents tab", () => {
  it("says what goes there when the course has none, and reminds the licence", async () => {
    renderTab(ok(libraryOf([])));
    expect(await screen.findByText("No documents yet")).toBeInTheDocument();
    expect(screen.getByText(/PDF and Markdown files of the course/)).toBeInTheDocument();
    expect(screen.getByText(/A standard's licence may forbid it/)).toBeInTheDocument();
    expect(screen.getByText(/ of 100 MB$/)).toBeInTheDocument();
  });

  it("says when the library could not be read", async () => {
    renderTab(fail(500, { error: "internal_error" }));
    expect(await screen.findByText("Could not load the documents")).toBeInTheDocument();
  });

  it("lists each document with its kind, size, uploader and warnings; a missing file has no download", async () => {
    renderTab(ok(libraryOf([pdf, sheet, { ...pdf, id: "0190d3c4-0000-7000-8000-0000000000e3", title: "Lost", filename: "lost.pdf", missing: true }])));
    expect(await screen.findByText("Datasheet")).toBeInTheDocument();
    expect(screen.getAllByText(/PDF ·/)).toHaveLength(2);
    expect(screen.getByText(/Markdown ·/)).toBeInTheDocument();
    expect(screen.getAllByText(/Ada Teacher/).length).toBeGreaterThan(0);
    expect(screen.getByText("Raw HTML is shown as text.")).toBeInTheDocument();
    expect(screen.getByText(/The image https:\/\/example.org\/a.png is left out/)).toBeInTheDocument();
    // The file's own name shows once the title is another.
    expect(screen.getByText("formulas.md")).toBeInTheDocument();
    expect(screen.getByText("File missing")).toBeInTheDocument();
    expect(screen.getByText(/The server has lost this file/)).toBeInTheDocument();
    const menus = screen.getAllByRole("button", { name: "Actions" });
    await userEvent.click(menus[0]!);
    expect(await screen.findByRole("menuitem", { name: "Download" })).toHaveAttribute(
      "href",
      `${URL_LIST}/${pdf.id}/file`,
    );
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("offers no delete on a document the reader may not delete", async () => {
    renderTab(ok(libraryOf([sheet])));
    await screen.findByText("Formula sheet");
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });

  it("says the space is full", async () => {
    renderTab(ok(libraryOf([pdf], 100 * MIB, 100 * MIB)));
    expect(await screen.findByText(/The course's space is full/)).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Space used" })).toHaveAttribute("aria-valuenow", String(100 * MIB));
  });

  it("sends the picked files one after the other and words each refusal", async () => {
    const posted: string[] = [];
    const replies: Reply[] = [
      { status: 201, body: pdf },
      fail(415, { error: "document_unsupported", message: "no" }),
      fail(413, { error: "file_too_large", message: "no", maxBytes: 50 * MIB }),
      fail(409, { error: "quota_exceeded", message: "no", usedBytes: 99 * MIB, quotaBytes: 100 * MIB }),
    ];
    const { calls } = renderTab(ok(libraryOf([])), {
      [`POST ${URL_LIST}`]: () => {
        posted.push("post");
        return replies[posted.length - 1]!;
      },
    });
    await screen.findByText("No documents yet");
    await userEvent.upload(picker(), [file("a.pdf"), file("b.md"), file("c.pdf"), file("d.pdf")]);
    expect(await screen.findByText("Files not added")).toBeInTheDocument();
    expect(posted).toHaveLength(4);
    expect(screen.getByText("b.md: neither a PDF nor a Markdown file.")).toBeInTheDocument();
    expect(screen.getByText("c.pdf: over 50 MB.")).toBeInTheDocument();
    expect(screen.getByText("d.pdf: only 1 MB left in the course.")).toBeInTheDocument();
    expect(screen.getByText("Document added")).toBeInTheDocument();
    // The list is read again once the batch is through.
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.url === URL_LIST).length).toBeGreaterThan(1));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Files not added")).toBeNull();
  });

  it("renames a document", async () => {
    const { calls } = renderTab(ok(libraryOf([sheet])), {
      [`PATCH ${URL_LIST}/${sheet.id}`]: ok({ ...sheet, title: "Formulas" }),
    });
    await screen.findByText("Formula sheet");
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename document" });
    const field = within(dialog).getByLabelText("Title shown to students");
    await userEvent.clear(field);
    await userEvent.type(field, "Formulas");
    await userEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ title: "Formulas" }));
  });

  it("deletes a document once confirmed", async () => {
    const { calls } = renderTab(ok(libraryOf([pdf])), { [`DELETE ${URL_LIST}/${pdf.id}`]: noContent() });
    await screen.findByText("Datasheet");
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete document" });
    expect(within(dialog).getByText(/Datasheet is removed from the course/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await screen.findByText("Document deleted")).toBeInTheDocument();
  });

  it("lets an administrator type the quota in, in MB", async () => {
    const quotaUrl = `/app/api/admin/courses/${COURSE}/documents-quota`;
    const { calls } = renderTab(ok(libraryOf([pdf])), {
      "GET /app/api/me": ok({ id: "a", email: "a@b", givenName: "A", familyName: "B", role: "admin" }),
      [`PATCH ${quotaUrl}`]: ok({ quotaBytes: 500 * MIB }),
    });
    const field = await screen.findByRole("spinbutton", { name: "Quota of the course, in MB" });
    expect(field).toHaveValue(100);
    await userEvent.clear(field);
    await userEvent.type(field, "500{Enter}");
    await waitFor(() => expect(calls.find((c) => c.url === quotaUrl)?.body).toEqual({ quotaBytes: 500 * MIB }));
  });

  it("shows no quota field to a teacher", async () => {
    renderTab(ok(libraryOf([pdf])));
    await screen.findByText("Datasheet");
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.getByText("2 MB of 100 MB")).toBeInTheDocument();
  });
});
