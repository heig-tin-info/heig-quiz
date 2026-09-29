import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { BottomNav } from "./BottomNav";

/*
 * The Drill slot of the student's bottom bar (#317): in the middle, only for
 * a student with a classroom whose drill is on, with a dot — never a count —
 * while today's drill holds something.
 */
const bar = () => screen.getByRole("navigation", { name: "Main navigation" });
const labels = () => within(bar()).getAllByRole("link").map((a) => a.textContent);

describe("the Drill slot", () => {
  it("is left out without a classroom whose drill is on", () => {
    renderWithProviders(
      <BottomNav route={{ view: "home" }} navigate={() => {}} drill={{ shown: false, available: false }} />,
    );
    expect(labels()).toEqual(["Activities", "Courses", "Grades", "Profile"]);
  });

  it("takes the middle, badged while today's drill is available", () => {
    renderWithProviders(
      <BottomNav route={{ view: "home" }} navigate={() => {}} drill={{ shown: true, available: true }} />,
    );
    expect(labels()).toEqual([
      "Activities",
      "Courses",
      "DrillToday's drill is available",
      "Grades",
      "Profile",
    ]);
    const drill = within(bar()).getByRole("link", { name: /^Drill/ });
    expect(drill).toHaveAttribute("href", "/drill");
    expect(within(drill).getByTestId("drill-available")).toBeInTheDocument();
  });

  it("drops the badge when there is nothing today, and lights the slot on its page", () => {
    renderWithProviders(
      <BottomNav route={{ view: "drill" }} navigate={() => {}} drill={{ shown: true, available: false }} />,
    );
    const drill = within(bar()).getByRole("link", { name: "Drill" });
    expect(drill).toHaveAttribute("aria-current", "page");
    expect(screen.queryByTestId("drill-available")).toBeNull();
  });
});
