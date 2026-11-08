import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { Button, EmptyState } from ".";

describe("EmptyState", () => {
  it("carries the one action of the surface", async () => {
    const onClick = vi.fn();
    const Icon = () => <svg aria-hidden />;
    renderWithProviders(
      <EmptyState
        icon={Icon}
        title="No classrooms"
        action={<Button onClick={onClick}>Create classroom</Button>}
      >
        Create your first classroom to distribute assignments.
      </EmptyState>,
    );
    expect(screen.getByText("No classrooms")).toBeVisible();
    // A `p` by default: an empty state inside a populated page must not
    // invent a heading level (W4).
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText(/distribute assignments/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Create classroom" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  /*
   * W4: the closed player is an empty state and nothing else. A page with no
   * heading of any level has no outline at all, so this one carries the h1.
   */
  it("becomes the page's heading when it IS the page", () => {
    const Icon = () => <svg aria-hidden />;
    renderWithProviders(<EmptyState icon={Icon} title="Time is up" titleAs="h1" />);
    expect(screen.getByRole("heading", { level: 1, name: "Time is up" })).toBeVisible();
  });
});
