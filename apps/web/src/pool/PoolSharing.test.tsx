import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { Pool, TeacherCandidate, PoolMembers } from "@quiz/contracts";

import { candidatesFor } from "../test/candidates";
import { flowingClock } from "../test/clock";
import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { PoolSharing } from "./PoolSharing";

/*
 * Sharing a pool, in its Settings tab: the visibility, the seats, and the row that gives one. The
 * owner's row is stated, never offered as a choice — it is the pool's own row.
 */

const POOL: Pool = {
  id: "p1",
  name: "Programmation C",
  icon: "code",
  color: null,
  visibility: "shared",
  isPublic: false,
  description: "",
  descriptionSource: "owner",
  ownerId: "u-me",
  isPersonal: false,
  createdAt: "2026-01-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
};

const MEMBERS = "/app/api/pools/p1/members";
const CANDIDATES = "/app/api/pools/p1/candidates";

const grace: TeacherCandidate = {
  userId: "t2",
  email: "grace.hopper@heig-vd.ch",
  givenName: "Grace",
  familyName: "Hopper",
};
const linus: TeacherCandidate = {
  userId: "t3",
  email: "linus.t@heig-vd.ch",
  givenName: "Linus",
  familyName: "Torvalds",
};

const list: PoolMembers = {
  visibility: "shared",
  courses: [],
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

describe("PoolSharing", () => {
  it("lists the seats, the owner's first and not removable", async () => {
    mockFetch({ [`GET ${MEMBERS}`]: ok(list) });
    renderWithProviders(<PoolSharing pool={POOL} />);

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
    renderWithProviders(<PoolSharing pool={POOL} />);
    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Role of Ada Lovelace" }),
      "reader",
    );
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ role: "reader" });
  });

  it("publishes the pool with one switch, and offers no way to evict the members", async () => {
    const { calls } = mockFetch({
      [`GET ${MEMBERS}`]: ok(list),
      "PATCH /app/api/pools/p1": ok(POOL),
    });
    renderWithProviders(<PoolSharing pool={POOL} />);
    await screen.findByText("Ada Lovelace");
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: /private/i })).toBeNull();

    await userEvent.click(screen.getByRole("switch", { name: "Publish in the catalogue" }));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ isPublic: true });
  });

  it("counts what unpublishing ends before it takes the pool back, and does nothing if cancelled", async () => {
    const { calls } = mockFetch({
      [`GET ${MEMBERS}`]: ok({ ...list, visibility: "public" }),
      "GET /app/api/pools/p1/unpublish-impact": ok({ subscribers: 3, readCourses: 1, templates: 2 }),
      "PATCH /app/api/pools/p1": ok(POOL),
    });
    renderWithProviders(<PoolSharing pool={{ ...POOL, visibility: "public", isPublic: true }} />);
    await screen.findByText("Ada Lovelace");

    await userEvent.click(screen.getByRole("switch", { name: "Publish in the catalogue" }));
    const dialog = await screen.findByRole("dialog", { name: "Take this pool out of the catalogue?" });
    expect(within(dialog).getByText(/3 subscribers stop following it\. 1 course loses its read-only link to it\. 2 templates/)).toBeVisible();
    // Cancelling leaves the pool published: nothing was written.
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);

    await userEvent.click(screen.getByRole("switch", { name: "Publish in the catalogue" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Unpublish" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ isPublic: false }));
  });

  it("unpublishes without a question when nobody follows or links the pool", async () => {
    const { calls } = mockFetch({
      [`GET ${MEMBERS}`]: ok({ ...list, visibility: "public" }),
      "GET /app/api/pools/p1/unpublish-impact": ok({ subscribers: 0, readCourses: 0, templates: 0 }),
      "PATCH /app/api/pools/p1": ok(POOL),
    });
    renderWithProviders(<PoolSharing pool={{ ...POOL, visibility: "public", isPublic: true }} />);
    await screen.findByText("Ada Lovelace");
    await userEvent.click(screen.getByRole("switch", { name: "Publish in the catalogue" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ isPublic: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says which linked courses only read the pool", async () => {
    mockFetch({
      [`GET ${MEMBERS}`]: ok({
        ...list,
        courses: [
          { id: "c1", name: "Programmation C", code: "PRG1", mode: "edit" },
          { id: "c2", name: "Systèmes", code: "SYS1", mode: "read" },
        ],
      }),
    });
    renderWithProviders(<PoolSharing pool={POOL} />);
    expect(await screen.findByText("Staff can read")).toBeVisible();
    expect(screen.getByText("Staff can edit")).toBeVisible();
  });

  it("cannot publish the personal pool", async () => {
    mockFetch({ [`GET ${MEMBERS}`]: ok(list) });
    renderWithProviders(<PoolSharing pool={{ ...POOL, isPersonal: true }} />);
    await screen.findByText("Ada Lovelace");
    expect(screen.getByRole("switch", { name: "Publish in the catalogue" })).toBeDisabled();
    expect(screen.getByText("Your personal pool cannot be published.")).toBeVisible();
  });

  it("lists the linked courses, read-only, with their effect", async () => {
    mockFetch({
      [`GET ${MEMBERS}`]: ok({ ...list, courses: [{ id: "c1", name: "Programmation C", code: "PRG1", mode: "edit" }] }),
    });
    renderWithProviders(<PoolSharing pool={POOL} />);
    expect(await screen.findByText("Linked courses")).toBeVisible();
    expect(screen.getByText("PRG1")).toBeVisible();
    expect(screen.getByText("Staff can edit")).toBeVisible();
  });

  it("on a public pool offers contributor and owner only, and marks the reader rows", async () => {
    const reader = { ...list.members[1]!, userId: "t9", givenName: "Rita", familyName: "Reader", role: "reader" as const };
    mockFetch({
      [`GET ${MEMBERS}`]: ok({ ...list, visibility: "public", members: [...list.members, reader] }),
    });
    renderWithProviders(<PoolSharing pool={{ ...POOL, visibility: "public", isPublic: true }} />);
    await screen.findByText("Rita Reader");
    expect(screen.getByRole("combobox", { name: "Role of Rita Reader" })).toHaveDisplayValue("Reader · covered by public");
    const invite = screen.getByRole("combobox", { name: "Role" });
    expect(within(invite).queryByRole("option", { name: "Reader" })).toBeNull();
    expect(within(invite).getAllByRole("option").map((o) => o.textContent)).toEqual(["Contributor", "Owner"]);
  });

  it("offers the colleagues by name, and invites the one picked by account", async () => {
    // The combobox closes on a real-time grace after a blur: on a faked clock,
    // that timer dies with the test instead of firing after the file is torn down.
    const user = flowingClock();
    const { calls } = mockFetch({
      [`GET ${MEMBERS}`]: ok(list),
      ...candidatesFor(CANDIDATES, "gra", [grace]),
      "POST /app/api/pools/p1/members": { status: 201, body: list },
    });
    renderWithProviders(<PoolSharing pool={POOL} />);

    const field = await screen.findByRole("combobox", { name: "Teacher" });
    // Nothing typed yet: not an address, nothing picked, nothing to send.
    expect(screen.getByRole("button", { name: /Invite/ })).toBeDisabled();
    await user.type(field, "gra");
    await user.click(await screen.findByRole("option", { name: /Grace Hopper/ }));
    expect(field).toHaveValue("Grace Hopper");
    expect(screen.getByText("grace.hopper@heig-vd.ch")).toBeVisible();

    await user.selectOptions(screen.getByRole("combobox", { name: "Role" }), "contributor");
    await user.click(screen.getByRole("button", { name: /Invite/ }));
    const post = calls.filter((c) => c.method === "POST").at(-1);
    expect(post?.body).toEqual({ userId: "t2", role: "contributor" });
    // The field is emptied for the next colleague.
    await waitFor(() => expect(field).toHaveValue(""));
  });

  it("still sends an address the list does not know, and names the refusal", async () => {
    // The combobox closes on a real-time grace after a blur: on a faked clock,
    // that timer dies with the test instead of firing after the file is torn down.
    const user = flowingClock();
    const { calls } = mockFetch({
      [`GET ${MEMBERS}`]: ok(list),
      ...candidatesFor(CANDIDATES, "Nobody@heig-vd.ch", []),
      "POST /app/api/pools/p1/members": fail(404, {
        error: "teacher_not_found",
        message: "No teacher account",
      }),
    });
    renderWithProviders(<PoolSharing pool={POOL} />);

    const field = await screen.findByRole("combobox", { name: "Teacher" });
    await user.type(field, "Nobody@heig-vd.ch");
    expect(await screen.findByText("No teacher matches “Nobody@heig-vd.ch”.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Invite/ }));
    expect(await screen.findByText("No teacher account with this e-mail.")).toBeVisible();
    const post = calls.filter((c) => c.method === "POST").at(-1);
    // Lower-cased on the way out, exactly as the contract stores it.
    expect(post?.body).toEqual({ email: "nobody@heig-vd.ch", role: "reader" });
  });

  it("says who has access when nobody does", async () => {
    mockFetch({
      [`GET ${MEMBERS}`]: ok({ visibility: "private", members: [list.members[0]!] }),
    });
    renderWithProviders(<PoolSharing pool={POOL} />);
    expect(await screen.findByText("Nobody else has access yet.")).toBeVisible();
  });

  it("shows the failure of the list, with a retry", async () => {
    mockFetch({ [`GET ${MEMBERS}`]: fail(500, { message: "Simulated failure" }) });
    renderWithProviders(<PoolSharing pool={POOL} />);
    const alert = await screen.findByRole("status");
    expect(within(alert).getByText("Simulated failure")).toBeVisible();
    expect(within(alert).getByRole("button", { name: /Retry/ })).toBeVisible();
  });
});
