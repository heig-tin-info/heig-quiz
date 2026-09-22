import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ViewModeToggle } from "./Header";
import { enterStudentView, leaveStudentView, useStudentView } from "./studentView";
import { renderWithProviders } from "./test/render";

/*
 * The frame's teacher/student switch (ADR-018 addendum).
 *
 * The component is drawn twice by the Shell — the sidebar and the phone top
 * bar — and both are wired to the same store, so what is asserted here is the
 * control itself and the store it drives. Where the Shell puts it, and who
 * gets one at all, is `Shell.test.tsx`.
 */

afterEach(() => sessionStorage.clear());

/** The toggle on the real store, the way `App` wires it. */
function Harness({ compact }: { compact?: boolean } = {}) {
  const studentView = useStudentView();
  return (
    <ViewModeToggle
      studentView={studentView}
      compact={compact}
      onToggle={() => {
        if (studentView) leaveStudentView();
        else enterStudentView({ view: "live", id: "e1" });
      }}
    />
  );
}

describe("ViewModeToggle", () => {
  it("draws the two views and marks the one on screen", () => {
    renderWithProviders(<Harness />);
    const group = screen.getByRole("radiogroup", { name: "View as" });
    expect(within(group).getByRole("radio", { name: "Teacher" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "Student" })).not.toBeChecked();
  });

  it("flips the store, in this tab only", async () => {
    renderWithProviders(<Harness />);
    const group = () => screen.getByRole("radiogroup", { name: "View as" });

    await userEvent.click(within(group()).getByRole("radio", { name: "Student" }));
    expect(within(group()).getByRole("radio", { name: "Student" })).toBeChecked();
    // Per WINDOW: a live dashboard open in another tab keeps the teacher UI.
    expect(sessionStorage.getItem("quiz-view-as")).toBe("student");
    expect(sessionStorage.getItem("quiz-view-as-return")).toBe("/evaluations/e1/live");
    expect(localStorage.getItem("quiz-view-as")).toBeNull();

    await userEvent.click(within(group()).getByRole("radio", { name: "Teacher" }));
    expect(sessionStorage.getItem("quiz-view-as")).toBe("teacher");
  });

  it("is one labelled icon on the phone top bar", async () => {
    const onToggle = vi.fn();
    renderWithProviders(<ViewModeToggle studentView={false} compact onToggle={onToggle} />);
    await userEvent.click(screen.getByRole("button", { name: "Switch to student view" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("says the way back on the phone top bar while the student view is on", () => {
    renderWithProviders(<ViewModeToggle studentView compact onToggle={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Back to teacher view" });
    expect(button).toHaveAttribute("aria-pressed", "true");
  });
});
