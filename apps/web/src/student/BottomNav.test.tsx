import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { BottomNav } from "./BottomNav";

/*
 * The Drill slot of the student's bottom bar (#317): which slots are drawn is
 * `visibleSlots`' (bottomNavSlots.test.ts); here, the dot — never a count —
 * while today's drill holds something, and the slot lit on its page.
 */
const SESSION = { cards: [], budgetMs: 600_000, nextDueAt: null };

describe("the Drill slot", () => {
  it("wears the dot while today's drill is available, and is lit on its page", () => {
    renderWithProviders(
      <BottomNav
        route={{ view: "drill" }}
        navigate={() => {}}
        drill={{ shown: true, available: true, session: SESSION }}
      />,
    );
    const bar = screen.getByRole("navigation", { name: "Main navigation" });
    const drill = within(bar).getByRole("link", { name: /Drill/ });
    expect(drill).toHaveAttribute("aria-current", "page");
    expect(within(drill).getByTestId("drill-available")).toBeInTheDocument();
    expect(within(drill).getByText("Today's drill is available")).toBeInTheDocument();
  });
});
