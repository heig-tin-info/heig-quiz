import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { Alert, Button } from ".";

describe("Alert", () => {
  it("renders its title, its body and its one action", async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <Alert
        tone="warning"
        title="This organization is on the GitHub Free plan"
        action={<Button onClick={onClick}>Request the upgrade</Button>}
      >
        Private repositories get no branch protection.
      </Alert>,
    );
    const alert = screen.getByRole("status");
    expect(within(alert).getByText("This organization is on the GitHub Free plan")).toBeVisible();
    expect(within(alert).getByText(/no branch protection/)).toBeVisible();
    await userEvent.click(within(alert).getByRole("button", { name: "Request the upgrade" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
