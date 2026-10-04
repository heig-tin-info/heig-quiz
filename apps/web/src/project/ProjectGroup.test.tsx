import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ProjectActivitySummary } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { ProjectGroup } from "./ProjectGroup";

/*
 * The classroom's Projects group (M3-10): drawn only while the classroom has
 * a project, a failure with its retry, a row per project that opens its
 * page (M3-12).
 */

const PROJECTS = "/app/api/classrooms/r1/projects";
const ROOM = { id: "00000000-0000-4000-8000-0000000000aa", name: "PRG1-2026", courseCode: "PRG1" };
const project = (n: number, over: Partial<ProjectActivitySummary> = {}): ProjectActivitySummary => ({
  kind: "project",
  id: `00000000-0000-4000-8000-00000000000${n}`,
  title: `Labo ${n}`,
  state: "published",
  classroom: ROOM,
  startAt: "2026-09-21T08:00:00.000Z",
  deadlineAt: "2026-10-05T22:00:00.000Z",
  ...over,
});

function renderGroup(locale: "en" | "fr" = "en") {
  const navigate = vi.fn();
  renderWithProviders(<ProjectGroup classroomId="r1" navigate={navigate} />, { locale });
  return navigate;
}

describe("the classroom's Projects group", () => {
  it("lists each project with its state, its start and its deadline, and opens it", async () => {
    const { calls } = mockFetch({
      [`GET ${PROJECTS}`]: ok([
        project(1, { state: "locked" }),
        project(2),
        project(3, { title: "Labo 3", state: "draft" }),
      ]),
    });
    const navigate = renderGroup();
    const region = await screen.findByRole("region", { name: "Projects" });
    expect(within(region).getByText("3")).toBeInTheDocument();
    const rows = within(region).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.querySelector(".font-semibold")?.textContent)).toEqual(["Labo 1", "Labo 2", "Labo 3"]);
    expect(within(rows[0]!).getByText("locked")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("published")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("draft")).toBeInTheDocument();
    expect(within(region).getByRole("columnheader", { name: /Deadline/ })).toBeInTheDocument();
    // No count of repositories or scores: those come with M3-08.
    expect(within(region).getAllByRole("columnheader")).toHaveLength(3);
    await userEvent.click(within(region).getByText("Labo 2"));
    expect(navigate).toHaveBeenCalledWith({ view: "project", id: project(2).id });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("draws nothing for a classroom without a project", async () => {
    const { fetchMock } = mockFetch({ [`GET ${PROJECTS}`]: ok([]) });
    renderGroup();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("region", { name: "Projects" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("draws nothing while the list loads: whether the group exists is not known yet", () => {
    mockFetch({});
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}));
    renderGroup();
    expect(screen.queryByRole("region")).toBeNull();
    expect(document.body.textContent).toBe("");
  });

  it("draws nothing on a platform without projects (404)", async () => {
    const { fetchMock } = mockFetch({ [`GET ${PROJECTS}`]: fail(404, { message: "Not found" }) });
    renderGroup();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Could not load the projects")).toBeNull();
  });

  it("says when the list failed, with a retry", async () => {
    mockFetch({ [`GET ${PROJECTS}`]: fail(500, { message: "boom" }) });
    renderGroup();
    expect(await screen.findByText("Could not load the projects")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("speaks French", async () => {
    mockFetch({ [`GET ${PROJECTS}`]: ok([project(1, { state: "locked" })]) });
    renderGroup("fr");
    const region = await screen.findByRole("region", { name: "Projets" });
    expect(within(region).getByText("verrouillé")).toBeInTheDocument();
    expect(within(region).getByRole("columnheader", { name: /Échéance/ })).toBeInTheDocument();
  });
});
