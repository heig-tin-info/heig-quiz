import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EVALUATION_ID, makeEvaluationDetail } from "../test/live-fixtures";
import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
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

  it("renders the failed state", async () => {
    mockFetch({ [DETAIL]: fail(500, { error: "internal_error" }) });
    render();
    expect(await screen.findByText("Could not load the exports.")).toBeInTheDocument();
  });
});
