import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CopyDownload } from "./CopyDownload";
import { mockFetch, ok, publicConfig, renderWithProviders } from "./test/render";

/*
 * "Download the copy" (ADR-125 §4, §5): a small menu, the PDF only when the
 * server makes PDFs, fetched so a refusal is a toast; the record a link.
 */

const COPY = "/app/api/evaluations/e1/results/attempts/a1/copy";

/** Opens the menu and returns its items' names. */
const open = async () => {
  await userEvent.click(await screen.findByRole("button", { name: "Download the copy" }));
  return (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
};

describe("CopyDownload", () => {
  it("offers the PDF first and the record, and downloads the PDF without leaving the page", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:pdf");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const { calls } = mockFetch({ ...publicConfig(true), [`GET ${COPY}.pdf`]: ok("%PDF-1.7") });
    renderWithProviders(<CopyDownload evaluationId="e1" attemptId="a1" />);
    await waitFor(async () => expect(await open()).toEqual(["PDF", "JSON"]));
    expect(screen.getByRole("menuitem", { name: "JSON" })).toHaveAttribute("href", `${COPY}.json`);
    await userEvent.click(screen.getByRole("menuitem", { name: "PDF" }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.url === `${COPY}.pdf`)).toHaveLength(1);
  });

  it("words a refusal of the PDF as a toast", async () => {
    mockFetch({ ...publicConfig(true), [`GET ${COPY}.pdf`]: () => ({ status: 503, body: { error: "pdf_unavailable" } }) });
    renderWithProviders(<CopyDownload evaluationId="e1" attemptId="a1" />);
    await waitFor(async () => expect(await open()).toContain("PDF"));
    await userEvent.click(screen.getByRole("menuitem", { name: "PDF" }));
    expect(await screen.findByText("PDF export is not available on this server.")).toBeInTheDocument();
  });

  it("offers only the record when the server makes no PDF", async () => {
    mockFetch(publicConfig(false));
    renderWithProviders(<CopyDownload evaluationId="e1" attemptId="a1" />);
    expect(await open()).toEqual(["JSON"]);
  });
});
