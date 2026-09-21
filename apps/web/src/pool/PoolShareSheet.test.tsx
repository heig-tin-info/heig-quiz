import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PoolMembers, PoolSummary } from "@quiz/contracts";

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

  it("invites a teacher, and names the two refusals in words", async () => {
    const { calls } = mockFetch({
      [`GET ${MEMBERS}`]: ok(list),
      "POST /app/api/pools/p1/members": (call) =>
        (call.body as { email: string }).email === "nobody@heig-vd.ch"
          ? fail(404, { error: "teacher_not_found", message: "No teacher account" })
          : { status: 204 },
    });
    renderWithProviders(<PoolShareSheet pool={POOL} onClose={vi.fn()} />);

    const email = await screen.findByLabelText("E-mail");
    await userEvent.type(email, "nobody@heig-vd.ch");
    await userEvent.click(screen.getByRole("button", { name: /Invite/ }));
    expect(await screen.findByText("No teacher account with this e-mail.")).toBeVisible();

    await userEvent.clear(email);
    await userEvent.type(email, "Grace.Hopper@heig-vd.ch");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Role" }), "contributor");
    await userEvent.click(screen.getByRole("button", { name: /Invite/ }));

    const post = calls.filter((c) => c.method === "POST").at(-1);
    // Lower-cased on the way out, exactly as the contract stores it.
    expect(post?.body).toEqual({ email: "grace.hopper@heig-vd.ch", role: "contributor" });
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
