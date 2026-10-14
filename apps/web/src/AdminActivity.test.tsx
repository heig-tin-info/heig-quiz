import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { ActivityCount, AdminActivity } from "@quiz/contracts";

import { ActivitySection } from "./AdminActivity";
import { fail, mockFetch, ok, renderWithProviders } from "./test/render";
import { heatStep } from "./ui";

const GET = "GET /app/api/admin/activity";
const DATES = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"];

const empty = (): ActivityCount[] => Array.from({ length: 24 }, () => ({ students: 0, staff: 0 }));

function activity(cells: Record<string, Record<number, ActivityCount>> = {}): AdminActivity {
  return {
    generatedAt: "2026-10-26T10:00:00.000Z",
    activeNow: { students: 4, staff: 1 },
    last24h: { students: 30, staff: 3 },
    last7d: { students: 120, staff: 9 },
    offHoursStudentShare: 0.234,
    recordedSince: "2026-10-18",
    days: DATES.map((date) => {
      const hours = empty();
      for (const [h, c] of Object.entries(cells[date] ?? {})) hours[Number(h)] = c;
      return { date, hours };
    }),
  };
}

describe("heatStep", () => {
  it("is 0 for nothing, then 1 to 5 by the share of the top", () => {
    expect(heatStep(0, 10)).toBe(0);
    expect(heatStep(1, 10)).toBe(1);
    expect(heatStep(5, 10)).toBe(3);
    expect(heatStep(10, 10)).toBe(5);
    expect(heatStep(3, 0)).toBe(0);
  });
});

describe("the Activity tab (F-ADMIN-09, ADR-107)", () => {
  it("shows the figures, and each hour's exact count under its day and hour", async () => {
    mockFetch({
      [GET]: ok(
        activity({
          // Monday 26 at 09:00 (class hours) and Sunday 25 at 21:00 (outside).
          "2026-10-26": { 9: { students: 12, staff: 3 } },
          "2026-10-25": { 21: { students: 5, staff: 0 } },
        }),
      ),
    });
    renderWithProviders(<ActivitySection />);

    expect(await screen.findByText("Active now")).toBeInTheDocument();
    expect(screen.getByText("4 students · 1 staff")).toBeInTheDocument();
    expect(screen.getByText("23%")).toBeInTheDocument();
    // The window is written out, with its time zone.
    expect(screen.getAllByText(/Mon–Fri 08:00–18:00 \(Europe\/Zurich\)/).length).toBeGreaterThan(0);

    const grid = screen.getByRole("table", { name: /active people per hour/i });
    const class9 = within(grid).getByTitle(/09:00–10:00: 15 active$/);
    expect(class9).toHaveTextContent("15");
    expect(class9).not.toHaveAttribute("data-off");
    const evening = within(grid).getByTitle(/21:00–22:00: 5 active · outside class hours/);
    expect(evening).toHaveAttribute("data-off", "true");

    // Staff only: the student-only hour empties.
    await userEvent.click(screen.getByRole("radio", { name: "Staff" }));
    expect(within(grid).getByTitle(/09:00–10:00: 3 active$/)).toHaveTextContent("3");
    expect(within(grid).getByTitle(/Oct 25, 21:00–22:00: 0 active/)).not.toHaveTextContent(/[1-9]/);
  });

  it("says nothing was recorded yet, rather than draw an empty grid", async () => {
    mockFetch({
      [GET]: ok({ ...activity(), last7d: { students: 0, staff: 0 }, offHoursStudentShare: null, recordedSince: null }),
    });
    renderWithProviders(<ActivitySection />);
    expect(await screen.findByText(/no activity recorded yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("offers a retry when the figures cannot be read", async () => {
    mockFetch({ [GET]: fail(500) });
    renderWithProviders(<ActivitySection />);
    expect(await screen.findByRole("button", { name: /retry|try again/i })).toBeInTheDocument();
  });
});
