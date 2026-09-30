import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClassroomView } from "./ClassroomView";
import { screenCommands } from "./screenCommands";
import { makeClassroomDetail } from "./test/fixtures";
import { fail, mockFetch, noContent, ok, renderWithProviders } from "./test/render";

/*
 * The teacher classroom's Settings tab (F-ORG-13, D24): a route of its own
 * (`/classrooms/:id/settings`), drawn under the classroom's header like the
 * other tabs. It holds what the header held — rename, archive, delete — and
 * the drill switch the Drill tab held. Its GitHub section has its own tests
 * (`github/ClassroomGithub.test.tsx`); here the platform has no App, so the
 * route answers 404 and the section is not drawn.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const ROOM = "/app/api/classrooms/r1";
const SETTINGS = "/classrooms/r1/settings";

function renderSettings(navigate = vi.fn()) {
  renderWithProviders(<ClassroomView id="r1" navigate={navigate} settings />, { route: SETTINGS });
  return navigate;
}

describe("the classroom's Settings tab", () => {
  it("is the selected tab, with its rows and no GitHub section without an App", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()) });
    renderSettings();
    expect(await screen.findByRole("tab", { name: /Settings/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Name")).toBeVisible();
    expect(screen.getByRole("switch", { name: "Drill" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Archive" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Delete classroom/ })).toBeVisible();
    // No accent on the tab while GitHub is absent, and none in the header.
    expect(screen.queryByRole("heading", { name: "GitHub" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add students|New evaluation/ })).toBeNull();
  });

  it("is a route the tab opens", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()), [`GET ${ROOM}/evaluations`]: ok([]) });
    const navigate = vi.fn();
    renderWithProviders(<ClassroomView id="r1" navigate={navigate} />, { route: "/classrooms/r1?tab=roster" });
    await userEvent.click(await screen.findByRole("tab", { name: /Settings/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroomSettings", id: "r1" });
  });

  it("goes back to the classroom's own address for another tab", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()) });
    const navigate = renderSettings();
    await userEvent.click(await screen.findByRole("tab", { name: /Roster/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "r1" });
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("roster");
  });

  it("renames the classroom in a dialog", async () => {
    let name = "PRG1-2026";
    const { calls } = mockFetch({
      [`GET ${ROOM}`]: () => ok(makeClassroomDetail({ name })),
      [`PATCH ${ROOM}`]: (call) => {
        name = (call.body as { name: string }).name;
        return ok(makeClassroomDetail({ name }));
      },
    });
    renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename the classroom" });
    const input = within(dialog).getByRole("textbox", { name: "Name" });
    expect(input).toHaveValue("PRG1-2026");
    await userEvent.clear(input);
    await userEvent.type(input, "PRG1-2027");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH" && c.url === ROOM)?.body).toEqual({ name: "PRG1-2027" }),
    );
    expect(await screen.findByRole("heading", { level: 1, name: /PRG1-2027/ })).toBeVisible();
    expect(screen.getByText("Classroom renamed.")).toBeVisible();
  });

  it("reports a failed rename in a toast", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()), [`PATCH ${ROOM}`]: fail(500, {}) });
    renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "-bis");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Could not rename this classroom/)).toBeVisible();
  });

  it("archives the classroom, and restores an archived one", async () => {
    const { calls } = mockFetch({
      [`GET ${ROOM}`]: ok(makeClassroomDetail()),
      [`POST ${ROOM}/archive`]: noContent(),
    });
    renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: "Archive" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === `${ROOM}/archive`)).toBe(true));
    expect(await screen.findByText("Classroom archived.")).toBeVisible();
  });

  it("offers Restore on an archived classroom", async () => {
    const { calls } = mockFetch({
      [`GET ${ROOM}`]: ok(makeClassroomDetail({ archivedAt: "2026-09-01T00:00:00.000Z" })),
      [`POST ${ROOM}/unarchive`]: noContent(),
    });
    renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(calls.some((c) => c.url === `${ROOM}/unarchive`)).toBe(true));
  });

  it("deletes the classroom after a confirmation, then goes home", async () => {
    const { calls } = mockFetch({
      [`GET ${ROOM}`]: ok(makeClassroomDetail()),
      [`DELETE ${ROOM}`]: noContent(),
    });
    const navigate = renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: /Delete classroom/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("PRG1-2026");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "home" }));
    expect(calls.some((c) => c.method === "DELETE" && c.url === ROOM)).toBe(true);
  });

  it("points the Drill tab's empty state at the switch, now in Settings", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()), [`GET ${ROOM}/drill/activity`]: ok([]) });
    const navigate = vi.fn();
    renderWithProviders(<ClassroomView id="r1" navigate={navigate} />, { route: "/classrooms/r1?tab=drill" });
    expect(await screen.findByText("The drill is off for this classroom")).toBeVisible();
    expect(screen.queryByRole("switch", { name: "Drill" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroomSettings", id: "r1" });
  });

  it("gives the palette 'Connect this classroom to GitHub' on a classroom not connected", async () => {
    mockFetch({
      [`GET ${ROOM}`]: ok(makeClassroomDetail()),
      [`GET ${ROOM}/evaluations`]: ok([]),
      [`GET ${ROOM}/github`]: ok({
        link: null,
        suggestedOrgId: null,
        installUrl: "https://github.com/apps/heig-quiz/installations/new?state=r1",
      }),
    });
    const navigate = vi.fn();
    renderWithProviders(<ClassroomView id="r1" navigate={navigate} />, { route: "/classrooms/r1?tab=roster" });
    await waitFor(() => expect(screenCommands().map((c) => c.id)).toContain("classroom-github-connect"));
    const command = screenCommands().find((c) => c.id === "classroom-github-connect")!;
    expect(command.label).toBe("Connect this classroom to GitHub");
    command.run();
    expect(navigate).toHaveBeenCalledWith({ view: "classroomSettings", id: "r1" });
    expect(new URLSearchParams(window.location.search).get("connect")).toBe("1");
  });
});
