import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ProjectSourceDetail, ProjectSourceRepo, ProjectSummary } from "@quiz/contracts";

import { makeQueryClient, mockFetch, fail, ok, renderWithProviders, type RouteHandler } from "../test/render";
import { NewProjectPage } from "./NewProjectPage";

/*
 * The new project (F-PROJ-01, M3-11): the novice's three fields and what
 * they send by default — the source's suggested protected files included —,
 * the advanced options, a date or a duration never both, each refusal where
 * it belongs, no second create while the first builds, and the way out on
 * success.
 */

const ROOM = "r1";
const BASE = `/app/api/classrooms/${ROOM}`;
const SOURCES: ProjectSourceRepo[] = [
  { name: "prg1-labo-04", defaultBranch: "main", private: true, pushedAt: "2026-10-01T08:00:00Z" },
  { name: "prg1-libre", defaultBranch: "master", private: false, pushedAt: null },
];
const DETAIL: ProjectSourceDetail = {
  name: "prg1-labo-04",
  defaultBranch: "main",
  branches: ["main", "solution"],
  tree: [
    { path: ".github/workflows/grading.yml", type: "blob" },
    { path: "README.md", type: "blob" },
    { path: "criteria.yml", type: "blob" },
    { path: "src", type: "tree" },
    { path: "src/arbre.c", type: "blob" },
  ],
  truncated: false,
  suggestedProtected: ["criteria.yml", "README.md", ".github/workflows/grading.yml"],
};
const SUMMARY = { id: "11111111-1111-4111-8111-111111111111" } as ProjectSummary;

function routes(post: RouteHandler = ok(SUMMARY), extra: Record<string, RouteHandler> = {}) {
  return mockFetch({
    [`GET ${BASE}`]: ok({ id: ROOM, name: "PRG1-2026", roster: [] }),
    [`GET ${BASE}/projects/sources`]: ok(SOURCES),
    [`GET ${BASE}/projects/sources/prg1-labo-04`]: ok(DETAIL),
    [`POST ${BASE}/projects`]: post,
    ...extra,
  });
}

function renderPage(locale: "en" | "fr" = "en") {
  const navigate = vi.fn();
  const queryClient = makeQueryClient();
  renderWithProviders(<NewProjectPage classroomId={ROOM} navigate={navigate} />, { locale, queryClient });
  return { navigate, queryClient };
}

/** The novice's three fields, filled; the deadline a week ahead, in the browser's zone. */
async function fillNovice() {
  await userEvent.type(await screen.findByLabelText("Name"), "Labo 4");
  await userEvent.selectOptions(await screen.findByLabelText("Source repository"), "prg1-labo-04");
  fireEvent.change(screen.getByLabelText("Deadline"), { target: { value: "2099-06-01T23:59" } });
  // The source's detail is read as soon as it is picked.
  await screen.findByText(/Default branch main/);
}

const posted = (calls: { method: string; body: unknown }[]) =>
  calls.filter((c) => c.method === "POST").map((c) => c.body as Record<string, unknown>);

describe("the new project form", () => {
  it("asks the novice three things and sends the defaults, the suggested protected files included", async () => {
    const { calls } = routes();
    renderPage();
    await fillNovice();
    // Advanced stays folded: none of its settings is on the page.
    expect(screen.queryByText("Branches")).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "History" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posted(calls)).toHaveLength(1));
    const body = posted(calls)[0]!;
    expect(body).toMatchObject({
      name: "Labo 4",
      sourceRepo: "prg1-labo-04",
      branches: ["main"],
      protectedFiles: ["criteria.yml", "README.md", ".github/workflows/grading.yml"],
      publishMode: "manual",
      graceMinutes: 30,
      sourceStrategy: "squash",
      deadlineStrategy: "lock",
      gradingMode: "auto",
      groupMode: false,
    });
    expect(body.deadlineAt).toBe(new Date("2099-06-01T23:59").toISOString());
    expect(body).not.toHaveProperty("startAt");
    expect(body).not.toHaveProperty("durationMinutes");
  });

  it("says what is missing and sends nothing", async () => {
    const { calls } = routes();
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Create" }));
    expect(await screen.findByText("Give the project a name.")).toBeInTheDocument();
    expect(screen.getByText("Choose the repository to hand out.")).toBeInTheDocument();
    expect(screen.getByText("Enter the deadline.")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(posted(calls)).toHaveLength(0);
  });

  it("sends the advanced options, and warns when grading.yml is unprotected", async () => {
    const { calls } = routes();
    renderPage();
    await fillNovice();
    await userEvent.click(screen.getByRole("button", { name: "Advanced options" }));
    await userEvent.click(screen.getByRole("button", { name: "solution" }));
    expect(screen.getByText(/The first one chosen, main,/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Whole history" }));
    await userEvent.click(screen.getByRole("radio", { name: "Mark" }));
    const grace = screen.getByLabelText("Grace");
    await userEvent.clear(grace);
    await userEvent.type(grace, "60");
    await userEvent.click(screen.getByRole("radio", { name: "Score is the grade" }));
    expect(screen.getByText(/A score out of 6 is the grade itself/)).toBeInTheDocument();
    expect(screen.queryByText(/workflow can be changed by the student/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: ".github/workflows/grading.yml" }));
    expect(screen.getByText(/workflow can be changed by the student/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Protect another file…"), "src/arbre.c");
    await userEvent.click(screen.getByRole("switch", { name: "Groups" }));
    await userEvent.type(screen.getByLabelText("Maximum group size"), "3");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posted(calls)).toHaveLength(1));
    expect(posted(calls)[0]).toMatchObject({
      branches: ["main", "solution"],
      sourceStrategy: "whole",
      deadlineStrategy: "commit",
      graceMinutes: 60,
      gradingScale: { kind: "score_is_grade" },
      protectedFiles: ["criteria.yml", "README.md", "src/arbre.c"],
      groupMode: true,
      groupMaxSize: 3,
    });
  });

  it("holds a date or a duration, and a start only when scheduled — never a start with a duration", async () => {
    const { calls } = routes();
    renderPage();
    await fillNovice();
    await userEvent.click(screen.getByRole("button", { name: "Advanced options" }));
    await userEvent.click(screen.getByRole("radio", { name: "A duration" }));
    expect(screen.queryByLabelText("Deadline")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Days"), "14");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posted(calls)).toHaveLength(1));
    expect(posted(calls)[0]).toMatchObject({ publishMode: "manual", durationMinutes: 14 * 1440 });
    expect(posted(calls)[0]).not.toHaveProperty("deadlineAt");
  });

  it("asks a start and a deadline for a scheduled publication, and offers no duration", async () => {
    const { calls } = routes();
    renderPage();
    await fillNovice();
    await userEvent.click(screen.getByRole("button", { name: "Advanced options" }));
    await userEvent.click(screen.getByRole("radio", { name: "A duration" }));
    await userEvent.click(screen.getByRole("radio", { name: "At the start" }));
    expect(screen.queryByRole("radiogroup", { name: "Deadline as" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Days")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Enter the start.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2099-06-10T08:00" } });
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("The deadline must come after the start.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2099-05-01T08:00" } });
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posted(calls)).toHaveLength(1));
    const body = posted(calls)[0]!;
    expect(body).toMatchObject({ publishMode: "scheduled", startAt: new Date("2099-05-01T08:00").toISOString() });
    expect(body.deadlineAt).toBe(new Date("2099-06-01T23:59").toISOString());
    expect(body).not.toHaveProperty("durationMinutes");
  });

  it.each([
    [
      "source_not_found",
      fail(422, { error: "source_not_found", message: "x" }),
      "Source repository",
      /can no longer be handed out/,
    ],
    [
      "source_not_found with branches",
      fail(422, { error: "source_not_found", message: "x", branches: ["solution"] }),
      "Source repository",
      /no longer has the branch solution/,
    ],
    ["deadline_past", fail(422, { error: "deadline_past", message: "x" }), "Deadline", /already passed/],
    ["duplicate_slug", fail(409, { error: "duplicate_slug", message: "x" }), "Name", /Too many projects/],
  ])("says %s under its field", async (_, reply, label, text) => {
    routes(reply);
    renderPage();
    await fillNovice();
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    const message = await screen.findByText(text);
    expect(screen.getByLabelText(label)).toHaveAttribute("aria-describedby", message.closest("[id]")!.id);
  });

  it("unfolds the branches when the source lacks one", async () => {
    routes(fail(422, { error: "source_not_found", message: "x", branches: ["solution"] }));
    renderPage();
    await fillNovice();
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("button", { name: "solution" })).toBeInTheDocument();
  });

  it("keeps the values after a failed build, says what stays on GitHub, and retries", async () => {
    let attempt = 0;
    const { calls } = routes(() =>
      ++attempt === 1 ? fail(502, { error: "distribution_failed", message: "x" }) : ok(SUMMARY),
    );
    const { navigate } = renderPage();
    await fillNovice();
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    const alert = (await screen.findByText("The students' repository could not be built")).closest("[role=status]")!;
    expect(within(alert as HTMLElement).getByText(/stays on GitHub/)).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Labo 4");
    await userEvent.click(within(alert as HTMLElement).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "project", id: SUMMARY.id }));
    expect(posted(calls)).toHaveLength(2);
    expect(posted(calls)[1]).toEqual(posted(calls)[0]);
  });

  it("says the ordinary failure for anything else", async () => {
    routes(fail(500, { message: "boom" }));
    renderPage();
    await fillNovice();
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Could not create the project")).toBeInTheDocument();
  });

  it("disables the form once sent, with one honest label, so nothing is created twice", async () => {
    const { calls, fetchMock } = routes();
    const answer = fetchMock.getMockImplementation()!;
    let release: () => void = () => {};
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST") await new Promise<void>((resolve) => (release = resolve));
      return answer(input, init);
    });
    renderPage();
    await fillNovice();
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    const building = await screen.findByRole("button", { name: /Building the students' repository/ });
    expect(building).toBeDisabled();
    expect(screen.getByLabelText("Name")).toBeDisabled();
    fireEvent.submit(building.closest("form")!);
    release();
    await waitFor(() => expect(screen.queryByRole("button", { name: /Building/ })).not.toBeInTheDocument());
    expect(posted(calls)).toHaveLength(1);
  });

  it("opens the project on success, the classroom's projects and the Activities invalidated", async () => {
    routes();
    const { navigate, queryClient } = renderPage();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await fillNovice();
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "project", id: SUMMARY.id }));
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(["classroom", ROOM, "projects"]);
    expect(keys).toContainEqual(["activities"]);
  });

  it.each([
    ["not_connected", "This classroom is not connected to GitHub"],
    ["app_not_installed", "Quiz's GitHub App is not installed on this organization"],
  ])("leads a classroom refused %s to its Settings' connect sheet", async (code, title) => {
    routes(undefined, { [`GET ${BASE}/projects/sources`]: fail(409, { error: code, message: "x" }) });
    const { navigate } = renderPage();
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect this classroom to GitHub" }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroomSettings", id: ROOM, connect: true });
  });

  it("waits for a source still being read when Create is pressed, its protected files sent", async () => {
    const { calls, fetchMock } = routes();
    const answer = fetchMock.getMockImplementation()!;
    let release: () => void = () => {};
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/sources/prg1-labo-04")) await new Promise<void>((resolve) => (release = resolve));
      return answer(input, init);
    });
    renderPage();
    await userEvent.type(await screen.findByLabelText("Name"), "Labo 4");
    await userEvent.selectOptions(await screen.findByLabelText("Source repository"), "prg1-labo-04");
    fireEvent.change(screen.getByLabelText("Deadline"), { target: { value: "2099-06-01T23:59" } });
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(posted(calls)).toHaveLength(0);
    expect(screen.queryByText("Could not read this repository.")).not.toBeInTheDocument();
    release();
    await waitFor(() => expect(posted(calls)).toHaveLength(1));
    expect(posted(calls)[0]).toMatchObject({ protectedFiles: DETAIL.suggestedProtected });
  });

  it("says a source that could not be read, with its retry", async () => {
    routes(undefined, { [`GET ${BASE}/projects/sources/prg1-labo-04`]: fail(500, { message: "boom" }) });
    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText("Source repository"), "prg1-labo-04");
    expect(await screen.findByText("Could not read this repository.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("says an empty organization", async () => {
    routes(undefined, { [`GET ${BASE}/projects/sources`]: ok([]) });
    renderPage();
    expect(await screen.findByText("This organization has no repository yet")).toBeInTheDocument();
  });

  it("says a failed read of the organization, with its retry", async () => {
    routes(undefined, { [`GET ${BASE}/projects/sources`]: fail(500, { message: "boom" }) });
    renderPage();
    expect(await screen.findByText("Could not load the organization's repositories")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });

  it("reads in French", async () => {
    routes();
    renderPage("fr");
    expect(await screen.findByRole("heading", { name: "Nouveau projet" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Dépôt source")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Créer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Options avancées" })).toBeInTheDocument();
  });
});
