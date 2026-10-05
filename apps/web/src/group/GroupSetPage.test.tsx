import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { GroupSetDetail } from "@quiz/contracts";

import { GROUP_1, GROUP_2, makeSet, ROOM_ID, SET_BASE, SET_ID, student } from "../test/group-fixtures";
import { fail, makeQueryClient, mockFetch, ok, renderWithProviders, type RecordedCall, type RouteHandler } from "../test/render";
import { GroupSetPage } from "./GroupSetPage";
import { withMove } from "./groupRules";

/*
 * A group set's page (ADR-070 §3, §6; M3-16a): its states, a move by the
 * menu and by click then click with the PUT it sends, Undo's reverse PUT and
 * its 404, the random formation's preview and cap, a group renamed in place
 * with its refusal, the deletion refused over the projects that follow it,
 * the archived classroom's read-only set, and the French of it.
 */

/** A project naming the set: a uuid, as `GroupRefusalProjects` parses it. */
const PROJECT = "0190d3c4-0000-7000-8000-0000000000b4";

function routes(set: GroupSetDetail | RouteHandler, extra: Record<string, RouteHandler> = {}) {
  return mockFetch({
    [`GET ${SET_BASE}`]: typeof set === "function" || "status" in set ? (set as RouteHandler) : ok(set),
    [`GET /app/api/classrooms/${ROOM_ID}`]: ok({ id: ROOM_ID, name: "PRG1-2026", roster: [] }),
    ...extra,
  });
}

function renderPage(locale: "en" | "fr" = "en", route = "/") {
  const navigate = vi.fn();
  renderWithProviders(<GroupSetPage classroomId={ROOM_ID} id={SET_ID} navigate={navigate} />, {
    locale,
    route,
    queryClient: makeQueryClient(),
  });
  return { navigate };
}

const writes = (calls: { method: string; url: string; body: unknown }[]) => calls.filter((c) => c.method !== "GET");
/** The answer of a move: the set with the student where the body put them. */
const moveAnswer =
  (base = makeSet()) =>
  (call: RecordedCall) =>
    ok(withMove(base, call.url.split("/").pop()!, (call.body as { groupId: string | null }).groupId));

describe("the page's states", () => {
  it("shows the set: its counts, the students in no group, the groups, the unclaimed marked", async () => {
    routes(makeSet());
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: /Projet final/ })).toBeInTheDocument();
    expect(screen.getByText("2 groups · 2 placed · 3 not placed")).toBeInTheDocument();
    const none = screen.getByRole("region", { name: "No group" });
    expect(within(none).getByRole("button", { name: /^Martin Chloé/ })).toBeInTheDocument();
    expect(within(none).getByRole("button", { name: /^Rochat David.*Has not signed in yet/ })).toBeInTheDocument();
    // The one primary while someone is in no group, and the secondary.
    expect(screen.getByRole("button", { name: "Form at random" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New group" })).toBeInTheDocument();
  });

  it("has no primary action once everyone is placed", async () => {
    routes(makeSet({ unplaced: [] }));
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: "Form at random" })).toBeNull();
    expect(screen.getByText("Everyone is in a group.")).toBeInTheDocument();
  });

  it("says a 404 is a set that does not exist, or is not the caller's", async () => {
    routes(fail(404, { message: "Not found" }));
    renderPage();
    expect(await screen.findByText("This group set does not exist, or it is not open to you.")).toBeInTheDocument();
  });

  it("is read-only on an archived classroom: an alert, and no control at all", async () => {
    routes(makeSet({}, { readOnly: true }));
    renderPage();
    expect(await screen.findByText("This classroom is archived; its groups are read-only.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Form at random|New group|More actions|Move .* to…/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Rename group set/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Martin Chloé/ })).toBeNull();
    expect(screen.getByText("Martin Chloé")).toBeInTheDocument();
  });

  it("leads back to the project it was opened from (?fromProject=<id>)", async () => {
    routes(makeSet({ usedBy: [{ id: "p-1", name: "Labo 4", archived: false, follows: true }] }));
    const { navigate } = renderPage("en", "/classrooms/x/groups/y?fromProject=p-1");
    await userEvent.click(await screen.findByRole("button", { name: "Labo 4" }));
    expect(navigate).toHaveBeenCalledWith({ view: "project", id: "p-1" });
  });
});

describe("a move", () => {
  it("sends the PUT from the menu, says it with Undo, and Undo sends the reverse PUT", async () => {
    const { calls } = routes(makeSet(), { [`PUT ${SET_BASE}/members/${student(2).enrollmentId}`]: moveAnswer() });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Move Martin Chloé to…" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Groupe 2" }));
    expect(await screen.findByText("Martin Chloé moved to Groupe 2")).toBeInTheDocument();
    // Drawn at once, before the answer, then kept.
    expect(within(screen.getByRole("listitem", { name: "Groupe 2" })).getByText("Martin Chloé")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(writes(calls).map((c) => c.body)).toEqual([{ groupId: GROUP_2 }, { groupId: null }]),
    );
    // The reverse move offers no Undo of its own (the first toast leaves on its animation's end, which jsdom never plays).
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
  });

  it("says Cannot undo when the group the student came from is gone (404)", async () => {
    let n = 0;
    routes(makeSet(), {
      [`PUT ${SET_BASE}/members/${student(0).enrollmentId}`]: (call) =>
        (n += 1) === 1 ? moveAnswer()(call) : fail(404, { message: "Not found" }),
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Move Dupont Alice to…" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "No group" }));
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Cannot undo: that group no longer exists.")).toBeInTheDocument();
  });

  it("moves by click then click with the keyboard: Enter on the student, Enter on the group's Move here", async () => {
    const { calls } = routes(makeSet(), { [`PUT ${SET_BASE}/members/${student(4).enrollmentId}`]: moveAnswer() });
    renderPage();
    const emma = await screen.findByRole("button", { name: /^Vuille Emma/ });
    emma.focus();
    await userEvent.keyboard("{Enter}");
    expect(emma).toHaveAttribute("aria-pressed", "true");
    screen.getByRole("button", { name: "Move into Groupe 1" }).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({ method: "PUT", url: `${SET_BASE}/members/${student(4).enrollmentId}`, body: { groupId: GROUP_1 } }),
      ]),
    );
  });

  it("puts the student back when the move is refused, and says why", async () => {
    routes(makeSet(), {
      [`PUT ${SET_BASE}/members/${student(2).enrollmentId}`]: fail(409, { error: "classroom_archived", message: "x" }),
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Move Martin Chloé to…" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Groupe 2" }));
    expect(await screen.findByText("This classroom is archived; its groups are read-only.")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(screen.getByRole("region", { name: "No group" })).getByText("Martin Chloé")).toBeInTheDocument(),
    );
  });
});

describe("a write that meets a set changed meanwhile", () => {
  it("says a 404 in the reader's words, never the server's, and reads the set again", async () => {
    const { calls } = routes(makeSet(), {
      [`PUT ${SET_BASE}/members/${student(2).enrollmentId}`]: fail(404, { message: "Not found" }),
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Move Martin Chloé to…" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Groupe 2" }));
    expect(
      await screen.findByText("This group or student is no longer in the set. The set is shown as it now stands."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Not found")).toBeNull();
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.url === SET_BASE)).toHaveLength(2));
  });
});

describe("the random formation", () => {
  const many = makeSet({
    groups: [],
    unplaced: Array.from({ length: 23 }, (_, i) => ({ ...student(i), enrollmentId: `0190d3c4-0000-7000-8000-00000000e${String(i).padStart(3, "0")}` })),
  }, { maxSize: 3 });

  it("previews the sizes, switches the remainder, caps the size, and sends the body", async () => {
    const { calls } = routes(many, { [`POST ${SET_BASE}/random`]: ok(makeSet({ unplaced: [] })) });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Form at random" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("7 groups of 3 · 1 group of 2")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("radio", { name: "Larger groups" }));
    expect(within(dialog).getByText("2 groups of 4 · 5 groups of 3")).toBeInTheDocument();
    expect(within(dialog).getByText("Some groups will be above the maximum size (3).")).toBeInTheDocument();
    const size = within(dialog).getByLabelText("Group size");
    await userEvent.clear(size);
    await userEvent.type(size, "24");
    expect(within(dialog).getByRole("button", { name: "Form the groups" })).toBeDisabled();
    expect(within(dialog).getByText("Choose a size from 1 to 23.")).toBeInTheDocument();
    await userEvent.clear(size);
    await userEvent.type(size, "4");
    await userEvent.click(within(dialog).getByRole("button", { name: "Form the groups" }));
    await waitFor(() => expect(writes(calls).map((c) => c.body)).toEqual([{ size: 4, remainder: "larger" }]));
    expect(await screen.findByText("5 groups formed")).toBeInTheDocument();
  });
});

describe("the groups and the set", () => {
  it("renames a group in place and keeps a duplicate_name refusal under the field", async () => {
    routes(makeSet(), {
      [`PATCH ${SET_BASE}/groups/${GROUP_2}`]: fail(409, { error: "duplicate_name", message: "taken" }),
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Groupe 2" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByLabelText("Group name");
    await userEvent.clear(field);
    await userEvent.type(field, "Groupe 1{Enter}");
    expect(await screen.findByText("Another group of this set already has this name.")).toBeInTheDocument();
    expect(screen.getByLabelText("Group name")).toHaveAttribute("aria-invalid", "true");
  });

  it("deletes a group after a confirmation", async () => {
    const { calls } = routes(makeSet(), { [`DELETE ${SET_BASE}/groups/${GROUP_2}`]: ok(makeSet()) });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Groupe 2" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete group" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(writes(calls).map((c) => c.method)).toEqual(["DELETE"]));
  });

  it("names the projects that refuse the set's deletion (set_in_use), as links", async () => {
    routes(makeSet(), {
      [`DELETE ${SET_BASE}`]: fail(409, {
        error: "set_in_use",
        message: "1 project(s)",
        projects: [{ id: PROJECT, name: "Labo 4 — en binômes" }],
      }),
    });
    const { navigate } = renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete group set" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("This group set is in use")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Labo 4 — en binômes" }));
    expect(navigate).toHaveBeenCalledWith({ view: "project", id: PROJECT });
  });

  it("names the projects whose group repository refuses a move (has_repo), and puts the student back", async () => {
    routes(makeSet(), {
      [`PUT ${SET_BASE}/members/${student(0).enrollmentId}`]: fail(409, {
        error: "has_repo",
        message: "1 project(s)",
        projects: [{ id: PROJECT, name: "Labo 4 — en binômes" }],
      }),
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Move Dupont Alice to…" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "No group" }));
    expect(await screen.findByText("This group has a repository: it cannot be deleted. Move its members out instead.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Labo 4 — en binômes" })).toBeInTheDocument();
    await waitFor(() =>
      expect(within(screen.getByRole("listitem", { name: "Groupe 1" })).getByText("Dupont Alice")).toBeInTheDocument(),
    );
  });

  it("speaks French", async () => {
    routes(makeSet());
    renderPage("fr");
    expect(await screen.findByRole("button", { name: "Répartir au hasard" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Sans groupe" })).toBeInTheDocument();
    expect(screen.getByText("2 groupes · 2 placés · 3 sans groupe")).toBeInTheDocument();
  });
});

describe("opening the set to its students (F-PROJ-22, M3-17)", () => {
  it("opens it until a date with a binding maximum: the PATCH, the risk said, max_size_required worded", async () => {
    const opened = makeSet({}, { maxSize: 3, openUntil: "2099-06-01T10:00:00.000Z", open: true });
    const { calls } = routes(makeSet(), {
      [`PATCH ${SET_BASE}`]: (call) =>
        (call.body as { maxSize?: number }).maxSize === 50
          ? fail(422, { error: "max_size_required", message: "needed" })
          : ok(opened),
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Open to students…" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/its first repository freezes the groups for the students/)).toBeInTheDocument();
    const submit = within(dialog).getByRole("button", { name: "Open" });
    // No maximum yet: it is required.
    expect(submit).toBeDisabled();
    const until = within(dialog).getByLabelText("Open until");
    await userEvent.clear(until);
    await userEvent.type(until, "2099-06-01T12:00");
    const max = within(dialog).getByLabelText("Maximum size");
    await userEvent.type(max, "50");
    await userEvent.click(submit);
    expect(await within(dialog).findByText("Set a maximum group size to open the groups to the students.")).toBeInTheDocument();
    await userEvent.clear(max);
    await userEvent.type(max, "3");
    await userEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const patch = writes(calls).at(-1)!;
    expect(patch.body).toEqual({ openUntil: new Date("2099-06-01T12:00").toISOString(), maxSize: 3 });
    expect(await screen.findByText(/^Open to students until/, { selector: "p.font-semibold" })).toBeInTheDocument();
  });

  it("says until when an open set is open, and closes it", async () => {
    const { calls } = routes(makeSet({}, { maxSize: 2, openUntil: "2099-06-01T10:00:00.000Z", open: true }), {
      [`PATCH ${SET_BASE}`]: ok(makeSet({}, { maxSize: 2 })),
    });
    renderPage();
    expect(await screen.findByText("They create, join and leave groups of at most 2.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close to students" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toEqual({ openUntil: null });
    await waitFor(() => expect(screen.queryByText("They create, join and leave groups of at most 2.")).toBeNull());
  });
});

