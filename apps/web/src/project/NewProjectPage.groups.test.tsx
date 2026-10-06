import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ProjectSourceDetail, ProjectSourceRepo, ProjectSummary } from "@quiz/contracts";

import { makeSet, makeSummary, SET_ID } from "../test/group-fixtures";
import { fail, makeQueryClient, mockFetch, ok, renderWithProviders, type RouteHandler } from "../test/render";

import { NewProjectPage } from "./NewProjectPage";

/*
 * The new project's group work (ADR-070 §7, M3-16a): the classroom's sets,
 * "Create new groups" that makes one and picks it, the set sent in group
 * mode only, and a set deleted under the form.
 */

const ROOM = "r1";
const BASE = `/app/api/classrooms/${ROOM}`;
const SOURCES: ProjectSourceRepo[] = [{ name: "prg1-labo-04", defaultBranch: "main", private: true, pushedAt: null }];
const DETAIL: ProjectSourceDetail = {
  name: "prg1-labo-04",
  defaultBranch: "main",
  branches: ["main"],
  tree: [],
  truncated: false,
  suggestedProtected: [],
};
const NEW_SET = "0190d3c4-0000-7000-8000-00000000f002";

function routes(post: RouteHandler = ok({ id: "11111111-1111-4111-8111-111111111111" } as ProjectSummary)) {
  return mockFetch({
    [`GET ${BASE}`]: ok({ id: ROOM, name: "PRG1-2026", course: { id: "co-1", code: "PRG1", name: "Programmation 1" }, roster: [] }),
    [`GET ${BASE}/projects/sources`]: ok(SOURCES),
    [`GET ${BASE}/projects/sources/prg1-labo-04`]: ok(DETAIL),
    [`GET ${BASE}/group-sets`]: ok([makeSummary()]),
    [`POST ${BASE}/group-sets`]: ok(makeSet({ groups: [] }, { id: NEW_SET, name: "Groups of 2026-10-05 10:00" })),
    [`POST ${BASE}/projects`]: post,
  });
}

async function fillWithGroups() {
  renderWithProviders(<NewProjectPage classroomId={ROOM} navigate={vi.fn()} />, { queryClient: makeQueryClient() });
  await userEvent.type(await screen.findByLabelText("Name"), "Labo 4");
  await userEvent.selectOptions(await screen.findByLabelText("Source repository"), "prg1-labo-04");
  fireEvent.change(screen.getByLabelText("Deadline"), { target: { value: "2099-06-01T23:59" } });
  await screen.findByText(/Default branch main/);
  await userEvent.click(screen.getByRole("button", { name: "Advanced options" }));
  await userEvent.click(screen.getByRole("switch", { name: "Groups" }));
}

const posted = (calls: { method: string; url: string; body: unknown }[]) =>
  calls.filter((c) => c.method === "POST" && c.url === `${BASE}/projects`).map((c) => c.body as Record<string, unknown>);

describe("the new project's group work", () => {
  it("lists the classroom's sets and sends the one chosen", async () => {
    const { calls } = routes();
    await fillWithGroups();
    const picker = await screen.findByLabelText("Group set");
    expect(screen.getByRole("option", { name: "Projet final — 2 groups · 3 not placed" })).toBeInTheDocument();
    await userEvent.selectOptions(picker, SET_ID);
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posted(calls)).toHaveLength(1));
    expect(posted(calls)[0]).toMatchObject({ groupMode: true, groupSetId: SET_ID });
  });

  it("creates new groups without leaving the form, and picks them", async () => {
    const { calls } = routes();
    await fillWithGroups();
    await userEvent.click(await screen.findByRole("button", { name: "Create new groups" }));
    expect(await screen.findByText("Group set created and chosen. Form its groups before publishing.")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST" && c.url === `${BASE}/group-sets`)).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posted(calls)).toHaveLength(1));
    expect(posted(calls)[0]).toMatchObject({ groupMode: true, groupSetId: NEW_SET });
  });

  it("sends no set once group mode is turned off again", async () => {
    const { calls } = routes();
    await fillWithGroups();
    await userEvent.selectOptions(await screen.findByLabelText("Group set"), SET_ID);
    await userEvent.click(screen.getByRole("switch", { name: "Groups" }));
    expect(screen.queryByLabelText("Group set")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posted(calls)).toHaveLength(1));
    expect(posted(calls)[0]).toMatchObject({ groupMode: false });
    expect(posted(calls)[0]).not.toHaveProperty("groupSetId");
  });

  it("says a set deleted under the form (422 unknown_group_set) and clears the choice", async () => {
    routes(fail(422, { error: "unknown_group_set", message: "gone" }));
    await fillWithGroups();
    await userEvent.selectOptions(await screen.findByLabelText("Group set"), SET_ID);
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("That group set no longer exists. Choose another one.")).toBeInTheDocument();
    expect(screen.getByLabelText("Group set")).toHaveValue("");
  });
});
