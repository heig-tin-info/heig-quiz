import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ModeBanner } from "./Shell";
import { renderWithProviders } from "./test/render";

describe("ModeBanner", () => {
  it("carries any message and any way out", async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <ModeBanner message="Acting as Ada" action={{ label: "End", onClick }}>
        <p>frame</p>
      </ModeBanner>,
    );
    const banner = screen.getByRole("region", { name: "Acting as Ada" });
    await userEvent.click(within(banner).getByRole("button", { name: "End" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByText("frame")).toBeVisible();
  });

  it("draws no button without an action", () => {
    renderWithProviders(<ModeBanner message="Read only">{null}</ModeBanner>);
    expect(within(screen.getByRole("region", { name: "Read only" })).queryByRole("button")).toBeNull();
  });
});
