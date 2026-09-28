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
const OFF = { available: false, linkedAt: null, teamsName: null, teamsUsername: null };
const UNLINKED = { available: true, linkedAt: null, teamsName: null, teamsUsername: null };
const LINKED = {
  available: true,
  linkedAt: "2026-09-20T08:00:00.000Z",
  teamsName: "Léa Rochat (HEIG-VD)",
  teamsUsername: "lea.rochat@heig-vd.ch",
};

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
    mockFetch({ [GET]: ok(settings(OFF)) });
    renderWithProviders(<SettingsPage me={makeMe({ role: "student" })} />);

    const grid = await screen.findByRole("table", { name: "Notifications" });
    expect(within(grid).getAllByRole("rowheader")).toHaveLength(1);
    expect(within(grid).getByText("Results released")).toBeVisible();
    expect(within(grid).queryByRole("columnheader", { name: "Teams" })).toBeNull();
    expect(screen.getByText("Sent to lea@heig.test. Nothing to set up.")).toBeVisible();
    expect(screen.getByText("Not available on this platform yet.")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Download the Teams app" })).toBeNull();
  });

  it("saves one toggle of the grid", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      [GET]: ok(settings(UNLINKED)),
      "PUT /app/api/notifications/preferences": ok(settings(UNLINKED)),
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

  it("offers the Teams app and the steps until Teams is linked, its switches off meanwhile", async () => {
    mockFetch({ [GET]: ok(settings(UNLINKED)) });
    renderWithProviders(<SettingsPage me={makeMe({ role: "teacher" })} />);
    const grid = await screen.findByRole("table", { name: "Notifications" });
    const teams = within(grid).getByRole("switch", { name: "Results released: Teams" });
    expect(teams).toBeDisabled();
    expect(teams).toHaveAttribute("aria-checked", "false");

    const download = screen.getByRole("link", { name: "Download the Teams app" });
    expect(download).toHaveAttribute("href", "/app/api/notifications/teams/app.zip");
    expect(download).toHaveAttribute("download");
    const steps = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveTextContent("Download the Teams app");
    expect(steps[1]).toHaveTextContent("Upload a customised app");
    expect(steps[2]).toHaveTextContent("Link to my Quiz account");
  });

  it("names the linked Teams account, and disconnects it", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      [GET]: ok(settings(LINKED)),
      "DELETE /app/api/notifications/teams": ok(settings(UNLINKED)),
    });
    renderWithProviders(<SettingsPage me={makeMe({ role: "teacher" })} />);

    const grid = await screen.findByRole("table", { name: "Notifications" });
    expect(within(grid).getByRole("switch", { name: "Results released: Teams" })).toBeEnabled();
    expect(screen.getByText(/Linked to Léa Rochat \(HEIG-VD\) \(lea\.rochat@heig-vd\.ch\) since/)).toBeVisible();
    expect(screen.queryByRole("link", { name: "Download the Teams app" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await screen.findByRole("link", { name: "Download the Teams app" })).toBeVisible();
  });

  it("offers a retry when the settings cannot be read", async () => {
    mockFetch({ [GET]: { status: 500, body: { error: "internal_error" } } });
    renderWithProviders(<SettingsPage me={makeMe({ role: "student" })} />);
    expect(await screen.findByRole("button", { name: /retry/i })).toBeVisible();
  });
});
