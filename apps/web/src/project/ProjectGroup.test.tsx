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
  // The phase follows the state unless a test refines a locked one (ADR-104).
  phase: over.state ?? "published",
  classroom: ROOM,
  startAt: "2026-09-21T08:00:00.000Z",
  deadlineAt: "2026-10-05T22:00:00.000Z",
  source: { fullName: "heig/lab-source" },
  distribution: { fullName: "heig/lab-squashed" },
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
    expect(within(region).getAllByRole("columnheader")).toHaveLength(4);
    await userEvent.click(within(region).getByText("Labo 2"));
    expect(navigate).toHaveBeenCalledWith({ view: "project", id: project(2).id });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("shows a dash for a date not fixed yet, sorted last, and the time left in the badge of a published project only (ADR-104)", async () => {
    // An hour past three days: the badge floors to the minute, and the render is not instant.
    const inThreeDays = new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString();
    mockFetch({
      [`GET ${PROJECTS}`]: ok([
        project(1, { title: "Undated", state: "draft", startAt: null, deadlineAt: null }),
        project(2, { title: "Planned", state: "draft" }),
        project(3, { title: "Running", deadlineAt: inThreeDays }),
        project(4, { title: "Done", state: "locked", deadlineAt: "2026-10-05T22:00:00.000Z" }),
      ]),
    });
    renderGroup();
    const region = await screen.findByRole("region", { name: "Projects" });
    const row = (title: string) => within(region).getByText(title).closest("tr")!;
    expect(within(row("Undated")).getAllByText("—")).toHaveLength(2);
    expect(within(row("Planned")).queryByText("—")).toBeNull();
    // The time left rides inside the state badge, with its sentence for a
    // screen reader; the deadline cell keeps the date alone (no "in 3 days").
    const running = within(row("Running"));
    expect(running.getByText("3 d")).toBeInTheDocument();
    expect(running.getByText("closes in 3 d")).toBeInTheDocument();
    expect(running.getByText("published").closest("span")).toContainElement(running.getByText("3 d"));
    expect(running.queryByText(/^in /)).toBeNull();
    expect(within(row("Planned")).queryByText(/closes in/)).toBeNull();
    expect(within(row("Done")).queryByText(/closes in|ago|^in /)).toBeNull();
    // Sorted by start, the undated one goes last in both directions.
    const titles = () => within(region).getAllByRole("row").slice(1).map((r) => r.querySelector(".font-semibold")?.textContent);
    await userEvent.click(within(region).getByRole("button", { name: /Start/ }));
    expect(titles().at(-1)).toBe("Undated");
    await userEvent.click(within(region).getByRole("button", { name: /Start/ }));
    expect(titles().at(-1)).toBe("Undated");
  });

  it("reads the badge from the phase: a locked project is graded in amber, released in outline green (ADR-104)", async () => {
    mockFetch({
      [`GET ${PROJECTS}`]: ok([
        project(1, { title: "Waiting", state: "locked" }),
        project(2, { title: "Graded", state: "locked", phase: "graded" }),
        project(3, { title: "Released", state: "locked", phase: "released" }),
      ]),
    });
    renderGroup();
    const region = await screen.findByRole("region", { name: "Projects" });
    const row = (title: string) => within(within(region).getByText(title).closest("tr")!);
    const waiting = row("Waiting").getByText("locked").className;
    expect(waiting).not.toContain("text-warning");
    expect(waiting).not.toContain("ring-current");
    expect(row("Graded").getByText("graded").className).toContain("text-warning");
    expect(row("Released").getByText("released").className).toContain("ring-current");
    // Over, whatever the phase: no timer.
    expect(within(region).queryByText(/closes in/)).toBeNull();
  });

  it("links the repositories in sight on the row, without opening the project (M3-14a, M3-14h)", async () => {
    mockFetch({
      [`GET ${PROJECTS}`]: ok([
        project(1, { title: "Built" }),
        project(2, { title: "Building", distribution: null }),
      ]),
    });
    const navigate = renderGroup();
    const region = await screen.findByRole("region", { name: "Projects" });
    const [built, building] = within(region).getAllByRole("row").slice(1);
    // No menu: the two links are on the row.
    expect(within(region).queryByRole("button", { name: /Actions for/ })).toBeNull();
    const source = within(built!).getByRole("link", { name: "Source repository" });
    expect(source).toHaveAttribute("href", "https://github.com/heig/lab-source");
    expect(source).toHaveAttribute("target", "_blank");
    expect(within(built!).getByRole("link", { name: "Distribution repository" })).toHaveAttribute(
      "href",
      "https://github.com/heig/lab-squashed",
    );
    await userEvent.click(source);
    expect(navigate).not.toHaveBeenCalled();
    // While the distribution is being built, its link is not there yet.
    expect(within(building!).getByRole("link", { name: "Source repository" })).toBeInTheDocument();
    expect(within(building!).queryByRole("link", { name: "Distribution repository" })).toBeNull();
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
    mockFetch({
      [`GET ${PROJECTS}`]: ok([
        project(1, { state: "locked" }),
        project(2, { state: "locked", phase: "graded" }),
        project(3, { state: "locked", phase: "released" }),
      ]),
    });
    renderGroup("fr");
    const region = await screen.findByRole("region", { name: "Projets" });
    expect(within(region).getByText("verrouillé")).toBeInTheDocument();
    // Never "publié", which names a published project (ADR-104).
    expect(within(region).getByText("corrigé")).toBeInTheDocument();
    expect(within(region).getByText("rendu")).toBeInTheDocument();
    expect(within(region).getByRole("columnheader", { name: /Échéance/ })).toBeInTheDocument();
  });
});
