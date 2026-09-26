import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { NotificationSettings } from "@quiz/contracts";

import { SettingsPage } from "../SettingsPage";
import { makeMe } from "../test/fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";

/*
 * Where each kind of notification goes (ADR-030): the grid of the kinds the
 * role receives, the address e-mails go to, and the Teams link.
 */

const ALL_ON = { bell: true, email: true, teams: true };

function settings(teams: NotificationSettings["teams"]): NotificationSettings {
  return {
    matrix: { results_released: ALL_ON, pool_shared: { ...ALL_ON, email: false }, pool_ownership: ALL_ON },
    email: "lea@heig.test",
    teams,
  };
}

const GET = "GET /app/api/notifications/settings";

describe("the notification settings", () => {
  it("shows a student the one kind they receive, and no Teams column when Teams is off", async () => {
    mockFetch({ [GET]: ok(settings({ available: false, linkedAt: null })) });
    renderWithProviders(<SettingsPage me={makeMe({ role: "student" })} />);

    const grid = await screen.findByRole("table", { name: "Notifications" });
    expect(within(grid).getAllByRole("rowheader")).toHaveLength(1);
    expect(within(grid).getByText("Results released")).toBeVisible();
    expect(within(grid).queryByRole("columnheader", { name: "Teams" })).toBeNull();
    expect(screen.getByText("Sent to lea@heig.test. Nothing to set up.")).toBeVisible();
    expect(screen.getByText("Not available on this platform yet.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect Microsoft Teams" })).toBeNull();
  });

  it("saves one toggle of the grid", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      [GET]: ok(settings({ available: true, linkedAt: null })),
      "PUT /app/api/notifications/preferences": ok(settings({ available: true, linkedAt: null })),
    });
    renderWithProviders(<SettingsPage me={makeMe({ role: "teacher" })} />);

    const grid = await screen.findByRole("table", { name: "Notifications" });
    expect(within(grid).getAllByRole("rowheader")).toHaveLength(3);
    const shared = within(grid).getByRole("switch", { name: "Pool shared with you: Email" });
    expect(shared).toHaveAttribute("aria-checked", "false");
    await user.click(shared);
    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT");
      expect(put?.body).toEqual({ kind: "pool_shared", channel: "email", enabled: true });
    });
  });

  it("keeps the Teams switches off and disabled until Teams is linked", async () => {
    mockFetch({ [GET]: ok(settings({ available: true, linkedAt: null })) });
    renderWithProviders(<SettingsPage me={makeMe({ role: "teacher" })} />);
    const grid = await screen.findByRole("table", { name: "Notifications" });
    const teams = within(grid).getByRole("switch", { name: "Results released: Teams" });
    expect(teams).toBeDisabled();
    expect(teams).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "Connect Microsoft Teams" })).toBeVisible();
  });

  it("starts the link at Microsoft, and disconnects a linked account", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      [GET]: ok(settings({ available: true, linkedAt: "2026-09-20T08:00:00.000Z" })),
      "DELETE /app/api/notifications/teams": ok(settings({ available: true, linkedAt: null })),
    });
    renderWithProviders(<SettingsPage me={makeMe({ role: "teacher" })} />);

    const grid = await screen.findByRole("table", { name: "Notifications" });
    expect(within(grid).getByRole("switch", { name: "Results released: Teams" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await screen.findByRole("button", { name: "Connect Microsoft Teams" })).toBeVisible();
  });

  it("offers a retry when the settings cannot be read", async () => {
    mockFetch({ [GET]: { status: 500, body: { error: "internal_error" } } });
    renderWithProviders(<SettingsPage me={makeMe({ role: "student" })} />);
    expect(await screen.findByRole("button", { name: /retry/i })).toBeVisible();
  });
});
