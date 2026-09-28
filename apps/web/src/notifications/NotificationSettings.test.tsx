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
    matrix: {
      results_released: ALL_ON,
      activity_scheduled: { bell: true, email: false, teams: false },
      activity_available: ALL_ON,
      deadline_approaching: ALL_ON,
      results_updated: { bell: true, email: false, teams: false },
      pool_shared: { ...ALL_ON, email: false },
      pool_ownership: ALL_ON,
      student_joined: { bell: true, email: false, teams: false },
      roster_conflict: ALL_ON,
      grading_ready: ALL_ON,
      pool_question_added: { bell: true, email: false, teams: false },
    },
    email: "lea@heig.test",
    teams,
  };
}

const GET = "GET /app/api/notifications/settings";

describe("the notification settings", () => {
  it("shows a student the kinds they receive, and no Teams column when Teams is off", async () => {
    mockFetch({ [GET]: ok(settings(OFF)) });
    renderWithProviders(<SettingsPage me={makeMe({ role: "student" })} />);

    const grid = await screen.findByRole("table", { name: "Notifications" });
    expect(within(grid).getAllByRole("rowheader")).toHaveLength(5);
    expect(within(grid).getByText("Results released")).toBeVisible();
    expect(within(grid).getByText("Exercise scheduled")).toBeVisible();
    expect(within(grid).getByText("Exercise open")).toBeVisible();
    expect(within(grid).getByText("Deadline approaching")).toBeVisible();
    expect(within(grid).getByText("Results updated")).toBeVisible();
    expect(within(grid).queryByText("Grading to validate")).toBeNull();
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
    expect(within(grid).getAllByRole("rowheader")).toHaveLength(11);
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

  /*
   * #198: ONE place for everything a user is told. The App channel is the
   * bell and the toast; the per-browser "Pop-up alerts" card is gone, and
   * the two kinds it held are rows of the grid, with their own defaults.
   */
  it("lists App, Email and Teams, the roster kinds as rows, and no pop-up alerts card", async () => {
    mockFetch({ [GET]: ok(settings(LINKED)) });
    renderWithProviders(<SettingsPage me={makeMe({ role: "teacher" })} />);
    const grid = await screen.findByRole("table", { name: "Notifications" });
    expect(within(grid).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Notifications",
      "App",
      "Email",
      "Teams",
    ]);
    const joined = (channel: string) =>
      within(grid).getByRole("switch", { name: `Student joined: ${channel}` });
    expect(joined("App")).toHaveAttribute("aria-checked", "true");
    expect(joined("Email")).toHaveAttribute("aria-checked", "false");
    expect(joined("Teams")).toHaveAttribute("aria-checked", "false");
    expect(within(grid).getByRole("switch", { name: "Roster entry to decide: Email" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByText(/pop-up alerts/i)).toBeNull();
    expect(screen.queryByText(/this browser only/i)).toBeNull();
  });

  it("offers a retry when the settings cannot be read", async () => {
    mockFetch({ [GET]: { status: 500, body: { error: "internal_error" } } });
    renderWithProviders(<SettingsPage me={makeMe({ role: "student" })} />);
    expect(await screen.findByRole("button", { name: /retry/i })).toBeVisible();
  });
});
