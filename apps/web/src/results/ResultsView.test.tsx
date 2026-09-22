import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeResultsView } from "../test/grading-fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { ResultsView } from "./ResultsView";

/*
 * The grade table, the export and the publication.
 *
 * The absent student is in the table AND in the statistics: a class average
 * computed on the students who showed up is a flattering fiction
 * (deviation W6-10).
 */

const VIEW = "/app/api/evaluations/e1/results";

/** The grade table is the last one: the histogram publishes a hidden one too. */
const names = () =>
  within(screen.getAllByRole("table").at(-1)!)
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[0]?.textContent);

describe("ResultsView", () => {
  it("shows the statistics, the histogram and one row per student", async () => {
    mockFetch({ [`GET ${VIEW}`]: ok(makeResultsView()) });
    renderWithProviders(<ResultsView evaluationId="e1" navigate={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Results" })).toBeVisible();
    expect(screen.getByText("Mean").nextSibling).toHaveTextContent("3.3");
    // 2 of the 4 rows are at 4.0 or above.
    expect(screen.getByText("Pass rate").nextSibling).toHaveTextContent("50%");
    expect(screen.getByText("absent")).toBeVisible();
    // Default order: by last name, the way a class list is read.
    expect(names()).toEqual(["Zoe Blanc", "Noah Currat", "Adam Perret", "Marie Rochat"]);
  });

  it("sorts on a column and flips it on a second click", async () => {
    mockFetch({ [`GET ${VIEW}`]: ok(makeResultsView()) });
    renderWithProviders(<ResultsView evaluationId="e1" navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "Results" });

    await userEvent.click(screen.getByRole("button", { name: "Grade" }));
    expect(names()).toEqual(["Noah Currat", "Adam Perret", "Marie Rochat", "Zoe Blanc"]);
    await userEvent.click(screen.getByRole("button", { name: "Grade" }));
    expect(names()).toEqual(["Zoe Blanc", "Marie Rochat", "Adam Perret", "Noah Currat"]);
  });

  it("exports through a real navigation to the CSV endpoint", async () => {
    mockFetch({ [`GET ${VIEW}`]: ok(makeResultsView()) });
    renderWithProviders(<ResultsView evaluationId="e1" navigate={vi.fn()} />);
    const link = await screen.findByRole("link", { name: /Export CSV/ });
    expect(link).toHaveAttribute("href", "/app/api/evaluations/e1/results.csv");
    expect(link).toHaveAttribute("download");
  });

  it("publishes only through a confirmation that names the evaluation", async () => {
    const { calls } = mockFetch({
      [`GET ${VIEW}`]: ok(makeResultsView()),
      "POST /app/api/evaluations/e1/release": ok({
        releasedAt: "2026-09-10T08:00:00.000Z",
        rows: 4,
        released: true,
      }),
    });
    renderWithProviders(<ResultsView evaluationId="e1" navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /Publish results/ }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Publish the results of “Quiz 3”?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ confirm: true }),
    );
  });

  it("flags a grading that moved after the publication", async () => {
    mockFetch({
      [`GET ${VIEW}`]: ok(
        makeResultsView({
          released: true,
          releasedAt: "2026-09-10T08:00:00.000Z",
          modifiedAfterRelease: true,
        }),
      ),
    });
    renderWithProviders(<ResultsView evaluationId="e1" navigate={vi.fn()} />);
    expect(await screen.findByText("Modified after publication")).toBeVisible();
  });

  it("offers the empty state rather than an empty table", async () => {
    mockFetch({
      [`GET ${VIEW}`]: ok(makeResultsView({ rows: [] })),
    });
    renderWithProviders(<ResultsView evaluationId="e1" navigate={vi.fn()} />);
    expect(await screen.findByText("No grade yet")).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
