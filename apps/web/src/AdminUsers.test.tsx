import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { AdminUser } from "@quiz/contracts";

import { UsersSection } from "./AdminUsers";
import { makeMe } from "./test/fixtures";
import { mockFetch, noContent, ok, renderWithProviders } from "./test/render";

const at = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

function user(id: string, familyName: string, rest: Partial<AdminUser> = {}): AdminUser {
  return {
    id,
    email: `${id}@heig-vd.ch`,
    givenName: "Test",
    familyName,
    avatarUrl: null,
    role: "student",
    reason: null,
    lastLoginAt: at(2),
    lastSeenAt: null,
    createdAt: at(500),
    pools: 0,
    questions: 0,
    classrooms: 0,
    lastActivityAt: at(2),
    inactive: false,
    dormantSince: null,
    due: false,
    ...rest,
  };
}

const USERS = [
  user("active", "Present"),
  user("idle", "Away", { lastActivityAt: at(400), inactive: true }),
  user("dormant", "Sleeping", { lastActivityAt: at(1100), inactive: true, dormantSince: at(380), due: true }),
  user("teacher", "Old", { role: "teacher", reason: "grant", lastActivityAt: at(1200), inactive: true, due: true }),
];

const session = (superPowersUntil: string | null) =>
  makeMe({
    role: "admin",
    session: { kind: "portal", evaluationId: null, projectId: null, readOnly: false, superPowersUntil, superPowersAvailable: true },
  });

async function openInactive() {
  const u = userEvent.setup();
  await u.click(await screen.findByRole("radio", { name: "Inactive" }));
  return u;
}

/*
 * ADR-117 §6: the administration's "Inactive" list, staff included, with
 * when each account was last there, since when it is dormant, and whether
 * it is past the term; one action per row, under Super Powers only.
 */
describe("UsersSection — inactive accounts", () => {
  it("lists only the accounts a year or more away, and offers no action without Super Powers", async () => {
    mockFetch({ "GET /app/api/admin/users": ok(USERS), "GET /app/api/me": ok(session(null)) });
    renderWithProviders(<UsersSection />);
    await openInactive();
    const table = await screen.findByRole("table");
    expect(within(table).queryByText("Test Present")).not.toBeInTheDocument();
    for (const name of ["Test Away", "Test Sleeping", "Test Old"]) expect(within(table).getByText(name)).toBeInTheDocument();
    expect(within(table).getAllByText("due")).toHaveLength(2);
    expect(screen.getByText(/switch super powers on to anonymize/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /anonymize/i })).not.toBeInTheDocument();
  });

  it("anonymizes a teacher with Super Powers on, behind the typed address", async () => {
    const { calls } = mockFetch({
      "GET /app/api/admin/users": ok(USERS),
      "GET /app/api/me": ok(session(new Date(Date.now() + 3_600_000).toISOString())),
      "POST /app/api/admin/users/teacher/pseudonymize": noContent(),
    });
    renderWithProviders(<UsersSection />);
    const u = await openInactive();
    await u.click(await screen.findByRole("button", { name: "Anonymize Test Old" }));
    const go = within(await screen.findByRole("dialog")).getByRole("button", { name: "Anonymize" });
    expect(go).toBeDisabled();
    await u.type(screen.getByRole("textbox", { name: /to confirm/i }), "teacher@heig-vd.ch");
    await u.click(go);
    expect(await screen.findByText("Account anonymized")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/app/api/admin/users/teacher/pseudonymize"))).toBe(true);
  });

  // ADR-117 §6: ANY account, not only an inactive one; the filter is where they are found.
  it("offers the action on every row of the full list with Super Powers on", async () => {
    mockFetch({
      "GET /app/api/admin/users": ok(USERS),
      "GET /app/api/me": ok(session(new Date(Date.now() + 3_600_000).toISOString())),
    });
    renderWithProviders(<UsersSection />);
    expect(await screen.findByRole("button", { name: "Anonymize Test Present" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^anonymize test/i })).toHaveLength(USERS.length);
  });
});
