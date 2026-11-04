import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EVALUATION_ID, makeEvaluationDetail } from "../test/live-fixtures";
import { fail, mockFetch, ok, publicConfig, renderWithProviders } from "../test/render";
import { ExportSheet } from "./ExportSheet";

/*
 * The export sheet (ADR-121 step 3, ADR-125): two documents, each a row of
 * downloads, or the reason the evaluation does not make it.
 */

const DETAIL = `GET /app/api/evaluations/${EVALUATION_ID}`;

const render = () =>
  renderWithProviders(<ExportSheet evaluationId={EVALUATION_ID} title="Quiz 3" onClose={vi.fn()} />);

const section = (name: string) => screen.getByRole("region", { name });

describe("the export sheet", () => {
  it("offers both documents as Markdown and JSON downloads", async () => {
    mockFetch({ [DETAIL]: ok(makeEvaluationDetail()) });
    render();
    expect(await screen.findByRole("dialog", { name: "Export" })).toBeInTheDocument();
    const handout = await screen.findByRole("region", { name: "Hand-out" });
    const links = within(handout).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      `/app/api/evaluations/${EVALUATION_ID}/handout.md`,
      `/app/api/evaluations/${EVALUATION_ID}/handout.json`,
    ]);
    for (const link of links) expect(link).toHaveAttribute("download");
    expect(within(section("Statement with answer key")).getByRole("link", { name: "JSON" })).toHaveAttribute(
      "href",
      `/app/api/evaluations/${EVALUATION_ID}/document.json`,
    );
  });

  it("greys a refused document out with its reason, and keeps the other", async () => {
    mockFetch({
      [DETAIL]: ok(makeEvaluationDetail({ exports: { document: null, handout: { reason: "type", types: ["code", "blocks"] } } })),
    });
    render();
    const handout = await screen.findByRole("region", { name: "Hand-out" });
    expect(within(handout).queryByRole("link")).not.toBeInTheDocument();
    expect(within(handout).getByText("Not available for: Code, Blocks")).toBeInTheDocument();
    expect(within(section("Statement with answer key")).getAllByRole("link")).toHaveLength(2);
  });

  it("says a parameterized question refuses both", async () => {
    const refusal = { reason: "parameterized" as const, types: [] };
    mockFetch({ [DETAIL]: ok(makeEvaluationDetail({ exports: { document: refusal, handout: refusal } })) });
    render();
    await screen.findByRole("region", { name: "Hand-out" });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getAllByText("Not available with a parameterized question.")).toHaveLength(2);
  });

  it("says why a poll is refused", async () => {
    const refusal = { reason: "poll" as const, types: [] };
    mockFetch({ [DETAIL]: ok(makeEvaluationDetail({ exports: { document: refusal, handout: refusal } })) });
    render();
    await screen.findByRole("region", { name: "Hand-out" });
    expect(screen.getAllByText("A poll is not printed.")).toHaveLength(2);
  });

  it("puts the PDF first when the server makes PDFs, fetched so a refusal is a toast (ADR-125)", async () => {
    mockFetch({
      [DETAIL]: ok(makeEvaluationDetail()),
      ...publicConfig(true),
      [`GET /app/api/evaluations/${EVALUATION_ID}/handout.pdf`]: () => ({ status: 503, body: { error: "pdf_busy" } }),
    });
    render();
    const handout = await screen.findByRole("region", { name: "Hand-out" });
    const pdf = await within(handout).findByRole("button", { name: "PDF" });
    // First of the row, before the two links.
    expect([...handout.querySelectorAll("a, button")].map((b) => b.textContent?.trim())).toEqual(["PDF", "Markdown", "JSON"]);
    await userEvent.click(pdf);
    expect(await screen.findByText("Too many PDFs at once: try again in a moment.")).toBeInTheDocument();
    // The sheet stays open.
    expect(screen.getByRole("dialog", { name: "Export" })).toBeInTheDocument();
    expect(within(section("Statement with answer key")).getByRole("button", { name: "PDF" })).toBeInTheDocument();
  });

  it("offers no PDF when the server makes none", async () => {
    mockFetch({ [DETAIL]: ok(makeEvaluationDetail()), ...publicConfig(false) });
    render();
    const handout = await screen.findByRole("region", { name: "Hand-out" });
    await waitFor(() => expect(within(handout).getAllByRole("link")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "PDF" })).not.toBeInTheDocument();
  });

  it("renders the failed state", async () => {
    mockFetch({ [DETAIL]: fail(500, { error: "internal_error" }) });
    render();
    expect(await screen.findByText("Could not load the exports.")).toBeInTheDocument();
  });
});
