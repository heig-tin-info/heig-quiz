import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CriteriaTableRow } from "@quiz/contracts";

import { makeQueryClient, mockFetch, ok, renderWithProviders } from "../../test/render";
import { CriteriaTable } from "./CriteriaTable";

const REPO = "/app/api/projects/p1/repos/r1";

const rows: CriteriaTableRow[] = [
  { criterionId: "rendu.tests", section: "rendu", description: "Tests pass", max: 12, points: 6, state: "proposed", locked: false, source: "auto" },
  { criterionId: "git.ssh", section: "git", description: "No key", max: -3, points: null, state: "empty", locked: false },
];

describe("CriteriaTable before its points can be written", () => {
  it("shows the points over the maximum as text, no field", () => {
    renderWithProviders(<CriteriaTable rows={rows} label="Criteria" writable={false} onGrade={vi.fn()} repoPath={REPO} />);
    const table = screen.getByRole("table", { name: "Criteria" });
    expect(within(table).queryByRole("spinbutton")).toBeNull();
    const [tests, key] = within(table).getAllByRole("row").slice(1);
    expect(tests).toHaveTextContent("6 / 12");
    expect(key).toHaveTextContent("— / −3");
  });
});

describe("CriteriaTable's CI output (ADR-119 §8)", () => {
  const render = (table: CriteriaTableRow[]) =>
    renderWithProviders(<CriteriaTable rows={table} label="Criteria" writable={false} onGrade={vi.fn()} repoPath={REPO} />, {
      queryClient: makeQueryClient(),
    });

  it("reads a CI pass's log only when its fold opens, and shows it as text", async () => {
    const log = "[  FAILED  ] parse <script>alert(1)</script>\n7/8 tests passed";
    const { calls } = mockFetch({ [`GET ${REPO}/criteria/rendu.tests/ci-log`]: ok({ log }) });
    render([{ ...rows[0]!, ciLog: true }, { ...rows[1]!, source: "manual" }]);
    const [tests, key] = within(screen.getByRole("table", { name: "Criteria" })).getAllByRole("row").slice(1);
    expect(within(key!).queryByRole("button", { name: "CI output" })).toBeNull();
    const fold = within(tests!).getByRole("button", { name: "CI output" });
    expect(calls).toEqual([]);
    await userEvent.click(fold);
    await waitFor(() => expect(tests!.querySelector("pre")?.textContent).toBe(log));
    expect(document.querySelector("script")).toBeNull();
  });

  it("says when the run wrote no log", async () => {
    mockFetch({ [`GET ${REPO}/criteria/rendu.tests/ci-log`]: ok({ log: null }) });
    render([{ ...rows[0]!, ciLog: true }]);
    await userEvent.click(screen.getByRole("button", { name: "CI output" }));
    expect(await screen.findByText("No output.")).toBeInTheDocument();
  });
});
