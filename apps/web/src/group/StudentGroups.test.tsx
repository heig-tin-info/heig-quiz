import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { StudentGroupSet, StudentGroupSets } from "@quiz/contracts";

import { fail, makeQueryClient, mockFetch, ok, renderWithProviders } from "../test/render";
import { isFull, primarySetId, StudentGroups, untilClosing } from "./StudentGroups";

/*
 * The student's Groups tab (F-PROJ-22, M3-17): an open set's groups and the
 * students in no group, the one primary "Create a group" while the reader is
 * in none, Join on a group that is not full, Leave and Rename on their own,
 * the bodies each write sends and a refusal worded; a closed set's own group
 * alone; a set the reader may not change drawn without a control; the empty
 * and error states; and the rules (`isFull`, `primarySetId`, `untilClosing`).
 */

const ROOM = "0190d3c4-0000-7000-8000-0000000000a1";
const SET = "0190d3c4-0000-7000-8000-0000000000b1";
const G1 = "0190d3c4-0000-7000-8000-0000000000c1";
const G2 = "0190d3c4-0000-7000-8000-0000000000c2";
const LIST = `/app/api/classrooms/${ROOM}/group-sets/student`;
const BASE = `/app/api/group-sets/${SET}/student`;
const NOW = "2026-10-05T10:00:00.000Z";

function makeView(over: Partial<StudentGroupSet> = {}, setOver: Partial<StudentGroupSet["set"]> = {}): StudentGroupSet {
  return {
    set: { id: SET, name: "Projet final", maxSize: 2, openUntil: "2026-10-08T21:59:00.000Z", open: true, ...setOver },
    writable: true,
    myGroupId: null,
    groups: [
      { id: G1, name: "Les As", size: 2, members: [{ nom: "Dupont", prenom: "Alice" }, { nom: "Favre", prenom: "Benoît" }] },
      { id: G2, name: "Groupe 2", size: 1, members: [{ nom: "Martin", prenom: "Chloé" }] },
    ],
    unplaced: [{ nom: "Rochat", prenom: "David" }],
    ...over,
  };
}

/** The list as the server answers it, read at `NOW`. */
const list = (...sets: StudentGroupSet[]): StudentGroupSets => ({ serverNow: NOW, sets });

function renderTab(sets: StudentGroupSet[] | ReturnType<typeof fail>, extra: Parameters<typeof mockFetch>[0] = {}) {
  const fetched = mockFetch({ [`GET ${LIST}`]: Array.isArray(sets) ? ok(list(...sets)) : sets, ...extra });
  renderWithProviders(<StudentGroups classroomId={ROOM} />, { queryClient: makeQueryClient() });
  return fetched;
}

const section = () => screen.findByRole("region", { name: "Projet final" });
const card = (name: string) => screen.getByRole("listitem", { name });

describe("an open set the reader is in no group of", () => {
  it("lists the groups and the students in none; Create is the one primary, Join only where there is room", async () => {
    renderTab([makeView()]);
    const region = await section();
    expect(within(region).getByText(/Open until .* · at most 2 per group/)).toBeInTheDocument();
    const create = within(region).getByRole("button", { name: "Create a group" });
    expect(create.className).toContain("bg-accent");
    // "Les As" holds two of two: full, no Join.
    expect(within(card("Les As")).getByText("full")).toBeInTheDocument();
    expect(within(card("Les As")).queryByRole("button", { name: "Join" })).toBeNull();
    expect(within(card("Les As")).getByText("Dupont Alice")).toBeInTheDocument();
    const join = within(card("Groupe 2")).getByRole("button", { name: "Join" });
    expect(join.className).not.toContain("bg-accent");
    expect(within(region).getByText("Rochat David")).toBeInTheDocument();
  });

  it("joins a group: the PUT with the group's id only", async () => {
    const after = makeView({ myGroupId: G2 });
    const { calls } = renderTab([makeView()], { [`PUT ${BASE}/membership`]: ok(list(after)) });
    await section();
    await userEvent.click(within(card("Groupe 2")).getByRole("button", { name: "Join" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ groupId: G2 });
    expect(await screen.findByText("You joined Groupe 2")).toBeInTheDocument();
  });

  it("creates a group, named or not, and words a refusal", async () => {
    const { calls } = renderTab([makeView()], {
      [`POST ${BASE}/groups`]: (call) =>
        (call.body as { name?: string }).name === "Les As"
          ? fail(409, { error: "duplicate_name", message: "taken" })
          : ok(list(makeView({ myGroupId: G2 }))),
    });
    await userEvent.click(within(await section()).getByRole("button", { name: "Create a group" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Group name"), "Les As");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create a group" }));
    expect(await within(dialog).findByText("Another group of this set already has this name.")).toBeInTheDocument();
    await userEvent.clear(within(dialog).getByLabelText("Group name"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create a group" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ name: "Les As" }, {}]);
  });

  it("says a closed set's refusal in the reader's words", async () => {
    renderTab([makeView()], { [`PUT ${BASE}/membership`]: fail(409, { error: "set_closed", message: "closed" }) });
    await section();
    await userEvent.click(within(card("Groupe 2")).getByRole("button", { name: "Join" }));
    expect(await screen.findByText("The groups are closed: they can no longer be changed here.")).toBeInTheDocument();
  });
});

describe("an open set the reader is in a group of", () => {
  it("has no primary; their group says so and offers Rename and Leave", async () => {
    const { calls } = renderTab([makeView({ myGroupId: G2 })], {
      [`DELETE ${BASE}/membership`]: ok(list(makeView())),
      [`PATCH ${BASE}/groups/${G2}`]: ok(list(makeView({ myGroupId: G2 }))),
    });
    const region = await section();
    expect(within(region).getByRole("button", { name: "Create a group" }).className).not.toContain("bg-accent");
    const mine = card("Groupe 2");
    expect(within(mine).getByText("your group")).toBeInTheDocument();
    expect(within(mine).queryByRole("button", { name: "Join" })).toBeNull();

    await userEvent.click(within(mine).getByRole("button", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByLabelText("Group name");
    expect(field).toHaveValue("Groupe 2");
    await userEvent.clear(field);
    await userEvent.type(field, "Nous");
    await userEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await userEvent.click(within(card("Groupe 2")).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.url, c.body])).toEqual([
      ["PATCH", `${BASE}/groups/${G2}`, { name: "Nous" }],
      ["DELETE", `${BASE}/membership`, null],
    ]);
  });
});

describe("what the reader may not change", () => {
  it("draws a closed set's own group alone, or says the teachers will place them", async () => {
    const closed = { open: false, openUntil: null };
    renderTab([
      makeView({ myGroupId: G1, groups: [makeView().groups[0]!], unplaced: undefined, writable: false }, closed),
      makeView({ myGroupId: null, groups: [], unplaced: undefined, writable: false }, { ...closed, id: G2, name: "Binômes" }),
    ]);
    const region = await section();
    expect(within(region).getByText("Closed")).toBeInTheDocument();
    expect(within(region).getByRole("listitem", { name: "Les As" })).toBeInTheDocument();
    expect(within(region).queryByRole("button")).toBeNull();
    const other = screen.getByRole("region", { name: "Binômes" });
    expect(within(other).getByText("You are in no group of this set. Your teachers will place you.")).toBeInTheDocument();
  });

  it("draws an open set without a control when the server says it is not writable (a teacher in the student view, a frozen set)", async () => {
    renderTab([makeView({ writable: false })]);
    const region = await section();
    expect(within(region).getByText("You can see these groups, not change them here.")).toBeInTheDocument();
    expect(within(region).queryByRole("button")).toBeNull();
  });

  it("says when there is nothing to form, and when the list failed", async () => {
    renderTab([]);
    expect(await screen.findByText("No groups to form here")).toBeInTheDocument();
  });

  it("offers a retry when the list failed", async () => {
    renderTab(fail(500, { message: "boom" }));
    expect(await screen.findByText("The groups could not be loaded.")).toBeInTheDocument();
  });

  it("speaks French", async () => {
    mockFetch({ [`GET ${LIST}`]: ok(list(makeView())) });
    renderWithProviders(<StudentGroups classroomId={ROOM} />, { queryClient: makeQueryClient(), locale: "fr" });
    expect(await screen.findByRole("button", { name: "Créer un groupe" })).toBeInTheDocument();
    expect(screen.getByText("Pas encore dans un groupe")).toBeInTheDocument();
  });
});

describe("the rules", () => {
  it("a group is full at the maximum or above; none without one", () => {
    expect(isFull({ size: 2 }, 2)).toBe(true);
    expect(isFull({ size: 3 }, 2)).toBe(true);
    expect(isFull({ size: 1 }, 2)).toBe(false);
    expect(isFull({ size: 9 }, null)).toBe(false);
  });

  it("the primary is the first set the reader may write while in no group of it", () => {
    const other = { ...makeView(), set: { ...makeView().set, id: G1 } };
    expect(primarySetId([makeView({ myGroupId: G2 }), other])).toBe(G1);
    expect(primarySetId([makeView({ writable: false })])).toBeNull();
  });

  it("waits for the soonest open set to close, by the answer's server clock", () => {
    expect(untilClosing(list(makeView()))).toBe(Date.parse("2026-10-08T21:59:00.000Z") - Date.parse(NOW));
    expect(untilClosing(list(makeView({}, { open: false, openUntil: null })))).toBeNull();
    expect(untilClosing({ serverNow: "2026-10-09T00:00:00.000Z", sets: [makeView()] })).toBe(0);
  });
});
