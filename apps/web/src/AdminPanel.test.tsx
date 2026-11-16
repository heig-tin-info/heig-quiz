import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { AdminTeacher } from "@quiz/contracts";

import { TeachersSection } from "./AdminPanel";
import { mockFetch, ok, renderWithProviders } from "./test/render";

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

    const always = await screen.findByRole("switch", { name: "Always on for an administrator" });
    expect(always).toBeChecked();
    expect(always).toBeDisabled();
    const theirs = screen.getByRole("switch", { name: "Online workspace for t@heig-vd.ch" });
    expect(theirs).not.toBeChecked();
    expect(theirs).toBeEnabled();

    const quota = screen.getByRole("spinbutton", { name: "Simultaneous workspaces for boss@heig-vd.ch" });
    const u = userEvent.setup();
    await u.clear(quota);
    await u.type(quota, "30");
    fireEvent.blur(quota);
    await screen.findByRole("switch", { name: "Always on for an administrator" });
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([
      { method: "PATCH", url: "/app/api/admin/teachers/boss/codespace", body: { maxActiveSessions: 30 } },
    ]);
  });
});
