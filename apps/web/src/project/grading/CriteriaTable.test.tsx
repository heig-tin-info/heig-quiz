import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CriteriaTableRow } from "@quiz/contracts";

import { renderWithProviders } from "../../test/render";
import { CriteriaTable } from "./CriteriaTable";

const rows: CriteriaTableRow[] = [
  { criterionId: "rendu.tests", section: "rendu", description: "Tests pass", max: 12, points: 6, state: "proposed", locked: false, source: "auto" },
  { criterionId: "git.ssh", section: "git", description: "No key", max: -3, points: null, state: "empty", locked: false },
];

describe("CriteriaTable before its points can be written", () => {
  it("shows the points over the maximum as text, no field", () => {
    renderWithProviders(<CriteriaTable rows={rows} label="Criteria" writable={false} onGrade={vi.fn()} />);
    const table = screen.getByRole("table", { name: "Criteria" });
    expect(within(table).queryByRole("spinbutton")).toBeNull();
    const [tests, key] = within(table).getAllByRole("row").slice(1);
    expect(tests).toHaveTextContent("6 / 12");
    expect(key).toHaveTextContent("— / −3");
  });
});

describe("CriteriaTable's CI check (ADR-119 §8)", () => {
  it("shows an automatic criterion's fraction, and its log folded, as text", async () => {
    const log = "[  FAILED  ] parse <script>alert(1)</script>\n7/8 tests passed";
    const checked: CriteriaTableRow[] = [{ ...rows[0]!, check: { score: " 7.5 / 10 ", log } }, { ...rows[1]!, source: "manual" }];
    renderWithProviders(<CriteriaTable rows={checked} label="Criteria" writable={false} onGrade={vi.fn()} />);
    const [tests, key] = within(screen.getByRole("table", { name: "Criteria" })).getAllByRole("row").slice(1);
    expect(within(tests!).getByTestId("ci-check")).toHaveTextContent("CI 7.5/10");
    expect(within(key!).queryByRole("button", { name: "CI log" })).toBeNull();
    const fold = within(tests!).getByRole("button", { name: "CI log" });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(fold);
    const shown = tests!.querySelector("pre")!;
    expect(shown.textContent).toBe(log);
    expect(document.querySelector("script")).toBeNull();
  });

  it("says when the run wrote no log", async () => {
    renderWithProviders(<CriteriaTable rows={[{ ...rows[0]!, check: { score: "1/1", log: null } }]} label="Criteria" writable={false} onGrade={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "CI log" }));
    expect(screen.getByText("No log.")).toBeInTheDocument();
  });
});
