import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PoolCandidate, PoolMembers, PoolSummary } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { PoolShareSheet } from "./PoolShareSheet";

/*
 * Sharing a pool: the visibility, the seats, and the row that gives one. The
 * owner's row is stated, never offered as a choice — it is the pool's own row.
 */

const POOL: PoolSummary = {
  id: "p1",
  name: "Programmation C",
  icon: "code",
  visibility: "shared",
  ownerId: "u-me",
  isPersonal: false,
  createdAt: "2026-01-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
  questionCount: 14,
  role: "owner",
  ownerName: "Prof Démo",
  memberCount: 1,
};

const MEMBERS = "/app/api/pools/p1/members";
const CANDIDATES = "/app/api/pools/p1/candidates";

const grace: PoolCandidate = {
  userId: "t2",
  email: "grace.hopper@heig-vd.ch",
  givenName: "Grace",
  familyName: "Hopper",
};
const linus: PoolCandidate = {
  userId: "t3",
  email: "linus.t@heig-vd.ch",
  givenName: "Linus",
  familyName: "Torvalds",
};

/** The picker asks after every keystroke: one stub per prefix of what is typed. */
function candidatesFor(typed: string, rows: PoolCandidate[]) {
  const stubs: Record<string, ReturnType<typeof ok>> = {};
  for (let i = 1; i <= typed.length; i += 1) {
    stubs[`GET ${CANDIDATES}?q=${encodeURIComponent(typed.slice(0, i))}`] = ok(rows);
  }
  return stubs;
}

const list: PoolMembers = {
  visibility: "shared",
  members: [
    {
      userId: "u-me",
      email: "teacher@heig-vd.ch",
      givenName: "Prof",
      familyName: "Démo",
      role: "owner",
      isOwner: true,
      addedAt: "2026-01-01T08:00:00.000Z",
    },
    {
      userId: "t1",
      email: "ada.lovelace@heig-vd.ch",
      givenName: "Ada",
      familyName: "Lovelace",
      role: "contributor",
      isOwner: false,
      addedAt: "2026-02-01T08:00:00.000Z",
    },
  ],
};

describe("PoolShareSheet", () => {
  it("lists the seats, the owner's first and not removable", async () => {
    mockFetch({ [`GET ${MEMBERS}`]: ok(list) });
    renderWithProviders(<PoolShareSheet pool={POOL} onClose={vi.fn()} />);

    expect(await screen.findByText("Prof Démo")).toBeVisible();
    expect(screen.getByText("Ada Lovelace")).toBeVisible();
    // One role select and one remove button: the owner's row has neither.
    expect(screen.getByRole("combobox", { name: "Role of Ada Lovelace" })).toHaveValue(
      "contributor",
    );
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(1);
    expect(screen.getByText(/the pool goes to the first member added/)).toBeVisible();
  });

  it("changes a role through its own endpoint", async () => {
    const { calls } = mockFetch({
      [`GET ${MEMBERS}`]: ok(list),
      "PATCH /app/api/pools/p1/members/t1": { status: 204 },
    });
    renderWithProviders(<PoolShareSheet pool={POOL} onClose={vi.fn()} />);
    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Role of Ada Lovelace" }),
      "reader",
    );
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ role: "reader" });
  });

  it("changes the visibility, and says what the choice means", async () => {
    const { calls } = mockFetch({
      [`GET ${MEMBERS}`]: ok(list),
      "PATCH /app/api/pools/p1": ok(POOL),
    });
    renderWithProviders(<PoolShareSheet pool={POOL} onClose={vi.fn()} />);
    await screen.findByText("Ada Lovelace");
    expect(
      screen.getByText("The teachers invited below, each with the role you give them."),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("radio", { name: /Public/ }));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ visibility: "public" });
  });

  it("offers the colleagues by name, and invites the one picked by account", async () => {
    const { calls } = mockFetch({
      [`GET ${MEMBERS}`]: ok(list),
      [`GET ${CANDIDATES}?q=`]: ok([grace, linus]),
      ...candidatesFor("gra", [grace]),
      "POST /app/api/pools/p1/members": { status: 201, body: list },
    });
    renderWithProviders(<PoolShareSheet pool={POOL} onClose={vi.fn()} />);

    const field = await screen.findByRole("combobox", { name: "Teacher" });
    // Nothing typed yet: not an address, nothing picked, nothing to send.
    expect(screen.getByRole("button", { name: /Invite/ })).toBeDisabled();
    await userEvent.type(field, "gra");
    await userEvent.click(await screen.findByRole("option", { name: /Grace Hopper/ }));
    expect(field).toHaveValue("Grace Hopper");
    expect(screen.getByText("grace.hopper@heig-vd.ch")).toBeVisible();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Role" }), "contributor");
    await userEvent.click(screen.getByRole("button", { name: /Invite/ }));
    const post = calls.filter((c) => c.method === "POST").at(-1);
    expect(post?.body).toEqual({ userId: "t2", role: "contributor" });
    // The field is emptied for the next colleague.
    await waitFor(() => expect(field).toHaveValue(""));
  });

  it("still sends an address the list does not know, and names the refusal", async () => {
    const { calls } = mockFetch({
      [`GET ${MEMBERS}`]: ok(list),
      [`GET ${CANDIDATES}?q=`]: ok([grace, linus]),
      ...candidatesFor("Nobody@heig-vd.ch", []),
      "POST /app/api/pools/p1/members": fail(404, {
        error: "teacher_not_found",
        message: "No teacher account",
      }),
    });
    renderWithProviders(<PoolShareSheet pool={POOL} onClose={vi.fn()} />);

    const field = await screen.findByRole("combobox", { name: "Teacher" });
    await userEvent.type(field, "Nobody@heig-vd.ch");
    expect(await screen.findByText("No teacher matches “Nobody@heig-vd.ch”.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /Invite/ }));
    expect(await screen.findByText("No teacher account with this e-mail.")).toBeVisible();
    const post = calls.filter((c) => c.method === "POST").at(-1);
    // Lower-cased on the way out, exactly as the contract stores it.
    expect(post?.body).toEqual({ email: "nobody@heig-vd.ch", role: "reader" });
  });

  it("says who has access when nobody does", async () => {
    mockFetch({
      [`GET ${MEMBERS}`]: ok({ visibility: "private", members: [list.members[0]!] }),
    });
    renderWithProviders(<PoolShareSheet pool={POOL} onClose={vi.fn()} />);
    expect(await screen.findByText("Nobody else has access yet.")).toBeVisible();
  });

  it("shows the failure of the list, with a retry", async () => {
    mockFetch({ [`GET ${MEMBERS}`]: fail(500, { message: "Simulated failure" }) });
    renderWithProviders(<PoolShareSheet pool={POOL} onClose={vi.fn()} />);
    const alert = await screen.findByRole("status");
    expect(within(alert).getByText("Simulated failure")).toBeVisible();
    expect(within(alert).getByRole("button", { name: /Retry/ })).toBeVisible();
  });
});
