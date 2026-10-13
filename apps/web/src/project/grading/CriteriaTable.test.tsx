import { screen, within } from "@testing-library/react";
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
