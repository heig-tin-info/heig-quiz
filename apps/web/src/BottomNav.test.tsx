import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BottomNav } from "./BottomNav";
import { renderWithProviders } from "./test/render";

/*
 * The Drill slot of the student's bottom bar (#317): which slots are drawn is
 * `visibleSlots`' (bottomNavSlots.test.ts); here, the dot — never a count —
 * while today's drill holds something, and the slot lit on its page.
 */
const SESSION = { cards: [], budgetMs: 600_000, nextDueAt: null };
const NO_DRILL = { shown: false, available: false, session: null };

describe("the Drill slot", () => {
  it("wears the dot while today's drill is available, and is lit on its page", () => {
    renderWithProviders(
      <BottomNav
        route={{ view: "drill" }}
        navigate={() => {}}
        teacherUi={false}
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

/*
 * The teacher's slots (#449): Polls in the middle, a link like the others —
 * no accent fill, the launcher's own primary is the screen's one (invariant 2).
 */
describe("the teacher's bar", () => {
  it("draws Activities, Courses, Poll, Classrooms and Profile, Poll lit on the launcher", () => {
    renderWithProviders(
      <BottomNav route={{ view: "polls" }} navigate={() => {}} teacherUi drill={NO_DRILL} />,
    );
    const bar = within(screen.getByRole("navigation", { name: "Main navigation" }));
    expect(bar.getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Activities", "/activities"],
      ["Courses", "/"],
      ["Poll", "/polls"],
      ["Classrooms", "/classrooms"],
      ["Profile", "/settings"],
    ]);
    const poll = bar.getByRole("link", { name: "Poll" });
    expect(poll).toHaveAttribute("aria-current", "page");
    expect(poll.className).toContain("bg-accent-soft");
    expect(poll.className.split(" ")).not.toContain("bg-accent");
  });
});
