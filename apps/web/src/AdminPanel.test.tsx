import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { AdminTeacher } from "@quiz/contracts";

import { AdminPage, TeachersSection } from "./AdminPanel";
import { configKey } from "./queryKeys";
import { makeQueryClient, mockFetch, ok, renderWithProviders } from "./test/render";

function row(id: string, email: string, rest: Partial<AdminTeacher> = {}): AdminTeacher {
  return {
    id,
    email,
    grantedAt: "2026-11-01T08:00:00.000Z",
    givenName: "Test",
    familyName: id,
    lastLoginAt: null,
    avatarUrl: null,
    signedUp: true,
    courses: 1,
    admin: false,
    codespace: { enabled: false, maxActiveSessions: 2 },
    ...rest,
  };
}

/*
 * ADR-047, amendment 2026-11-16: the administrator's address may hold a
 * grant row, for its quota. Their workspace is always on, so their switch
 * is on and inert; the quota is edited through the same route as anyone's.
 */
describe("TeachersSection — the administrator's workspace row", () => {
  it("shows the administrator's switch on and disabled, and saves their quota on the shared route", async () => {
    const { calls } = mockFetch({
      "GET /app/api/admin/teachers": ok([
        row("teacher", "t@heig-vd.ch"),
        row("boss", "boss@heig-vd.ch", { admin: true, codespace: { enabled: true, maxActiveSessions: 2 } }),
      ]),
      "PATCH /app/api/admin/teachers/boss/codespace": ok({ enabled: true, maxActiveSessions: 30 }),
    });
    renderWithProviders(<TeachersSection />);

    const always = await screen.findByRole("switch", { name: "Online workspace for boss@heig-vd.ch" });
    expect(always).toBeChecked();
    expect(always).toBeDisabled();
    const theirs = screen.getByRole("switch", { name: "Online workspace for t@heig-vd.ch" });
    expect(theirs).not.toBeChecked();
    expect(theirs).toBeEnabled();

    // The reason reaches a keyboard: the held switch's wrapper takes the focus.
    const u = userEvent.setup();
    act(() => always.parentElement!.focus());
    expect(await screen.findByText("Always on for an administrator")).toBeInTheDocument();

    const quota = screen.getByRole("spinbutton", { name: "Simultaneous workspaces for boss@heig-vd.ch" });
    await u.clear(quota);
    await u.type(quota, "30");
    fireEvent.blur(quota);
    await screen.findByRole("switch", { name: "Online workspace for boss@heig-vd.ch" });
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([
      { method: "PATCH", url: "/app/api/admin/teachers/boss/codespace", body: { maxActiveSessions: 30 } },
    ]);
  });

  it("asks to remove the administrator's quota, not their teacher role", async () => {
    mockFetch({
      "GET /app/api/admin/teachers": ok([
        row("teacher", "t@heig-vd.ch"),
        row("boss", "boss@heig-vd.ch", { admin: true, codespace: { enabled: true, maxActiveSessions: 30 } }),
      ]),
    });
    renderWithProviders(<TeachersSection />);
    const u = userEvent.setup();
    const bins = await screen.findAllByRole("button", { name: "Revoke" });
    // Sorted by name: "Test boss" before "Test teacher".
    await u.click(bins[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remove the workspace quota of boss@heig-vd.ch? It goes back to the default.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/teacher role/)).not.toBeInTheDocument();
    await u.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await u.click(bins[1]!);
    expect(await screen.findByText("Revoke the teacher role of t@heig-vd.ch?")).toBeInTheDocument();
  });
});

/*
 * The kiosk stations have their own tab, second, where the platform has the
 * kiosk path (ADR-051 §5); People keeps the grants and the accounts.
 * Elsewhere the tab does not exist, and `?tab=kiosk` opens People.
 */
describe("AdminPage — the kiosk stations' tab", () => {
  const render = (kiosk: boolean, route = "/admin") => {
    mockFetch({
      "GET /app/api/admin/teachers": ok([]),
      "GET /app/api/admin/users": ok([]),
      "GET /app/api/admin/kiosk-devices": ok([]),
    });
    const queryClient = makeQueryClient();
    queryClient.setQueryData(configKey, { devLogin: false, kiosk: kiosk ? { extensionId: null, mock: true } : null });
    return renderWithProviders(<AdminPage />, { queryClient, route });
  };
  const tabNames = () => screen.getAllByRole("tab").map((tab) => tab.textContent);

  it("lists the stations in a tab of their own, right after People", async () => {
    render(true);
    expect(tabNames().slice(0, 2)).toEqual(["People", "Kiosk stations"]);
    // People: the grants and the accounts, no station.
    expect(await screen.findByRole("heading", { name: /teachers/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /kiosk stations/i })).toBeNull();

    await userEvent.setup().click(screen.getByRole("tab", { name: "Kiosk stations" }));
    expect(await screen.findByText(/no station yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /teachers/i })).toBeNull();
  });

  it("has no such tab without the kiosk path, and ?tab=kiosk opens People", async () => {
    render(false, "/admin?tab=kiosk");
    expect(tabNames()).not.toContain("Kiosk stations");
    expect(screen.getByRole("tab", { name: "People" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("heading", { name: /teachers/i })).toBeInTheDocument();
  });

  it("opens the stations from the address where the platform has them", async () => {
    render(true, "/admin?tab=kiosk");
    expect(screen.getByRole("tab", { name: "Kiosk stations" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText(/no station yet/i)).toBeInTheDocument();
  });
});
