import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectDetail, ProjectWorkspace, WorkMode } from "@quiz/contracts";

import { BASE, CLASSROOM_ID, makeProject, makeRepo, PAST, row } from "../test/project-fixtures";
import { fail, mockFetch, ok, renderWithProviders, type RouteHandler } from "../test/render";
import { ProjectRepos } from "./ProjectRepos";
import { RepoSheet } from "./RepoSheet";

/*
 * The staff's *Open in workspace* (ADR-129 §11, F-PROJ-27): absent without
 * the portal or the holder's grant, absent on a repository that is not live,
 * held with its reason on a Safe Exam Browser repository whose deadline is
 * not applied, a POST then the portal's address, busy meanwhile, a refusal
 * worded by its code. The same rule on the row and on the sheet.
 */

const ROOM = `/app/api/classrooms/${CLASSROOM_ID}`;
const WS = `GET ${BASE}/workspace`;
const LIVE = makeRepo(1);
const PENDING = makeRepo(2, { provisionStatus: "pending", fullName: null });
const DELETED = makeRepo(3, { flags: { ...makeRepo(3).flags, deleted: true } });
const reviewUrl = (repoId: string) => `POST ${BASE}/repos/${repoId}/workspace/review`;
const LAUNCH = "https://workspace.heig-vd.ch/review?token=t";

const workspace = (over: Partial<ProjectWorkspace> = {}): ProjectWorkspace => ({
  mode: "free",
  allowed: ["free"],
  refusal: null,
  syncedAt: null,
  syncError: null,
  review: true,
  ...over,
});
const project = (over: Partial<ProjectDetail> = {}) =>
  makeProject({ rows: [row(1, LIVE), row(2, PENDING), row(3, DELETED), row(4, null)], ...over });

function routes(ws: RouteHandler, extra: Record<string, RouteHandler> = {}, archivedAt: string | null = null) {
  return mockFetch({
    [WS]: ws,
    [`GET ${ROOM}`]: ok({ id: CLASSROOM_ID, name: "PRG1-2026", archivedAt, course: { id: "c1", code: "PRG1", name: "C" }, roster: [] }),
    ...extra,
  });
}

const renderTable = (p: ProjectDetail, locale: "en" | "fr" = "en") => {
  const onOpen = vi.fn();
  renderWithProviders(<ProjectRepos project={p} onOpen={onOpen} navigate={vi.fn()} filter={null} onFilter={vi.fn()} />, { locale });
  return { onOpen };
};
const renderSheet = (p: ProjectDetail, repoId = LIVE.id) =>
  renderWithProviders(<RepoSheet project={p} repoId={repoId} onClose={vi.fn()} />);

const rowOf = (name: RegExp) => screen.getByText(name).closest("tr")!;
const FIRST = /labo-2-student-1$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Open in workspace, on the rows", () => {
  it("is offered on a live repository only, in a last column", async () => {
    routes(ok(workspace()));
    renderTable(project());
    const live = await screen.findByRole("button", { name: "Open in workspace" });
    expect(rowOf(FIRST)).toContainElement(live);
    // Not created yet, deleted on GitHub, not accepted: no action at all.
    expect(screen.getAllByRole("button", { name: "Open in workspace" })).toHaveLength(1);
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
  });

  it.each([
    ["the platform has no portal (the workspace read's 404)", fail(404, { error: "not_found" })],
    ["the quota holder holds no grant", ok(workspace({ review: false }))],
  ])("is not there when %s, nor its column", async (_case, ws) => {
    const { calls } = routes(ws);
    renderTable(project());
    await waitFor(() => expect(calls.some((c) => c.url === `${BASE}/workspace`)).toBe(true));
    await screen.findByText(FIRST);
    expect(screen.queryByRole("button", { name: "Open in workspace" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Actions" })).toBeNull();
  });

  it.each<[string, string | null, Partial<ProjectDetail>]>([
    ["an archived project", null, { archivedAt: PAST }],
    ["an archived classroom", PAST, {}],
  ])("is absent in %s", async (_case, roomArchived, over) => {
    const { calls } = routes(ok(workspace()), {}, roomArchived);
    renderTable(project(over));
    await waitFor(() => expect(calls.some((c) => c.url === ROOM)).toBe(true));
    await screen.findByRole("columnheader", { name: "Actions" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open in workspace" })).toBeNull());
  });

  it.each<[WorkMode, string | null, boolean]>([
    ["online_seb", null, true],
    ["online_seb", PAST, false],
    ["online", null, false],
  ])("under %s, the deadline applied %s: held %s", async (mode, appliedAt, held) => {
    routes(ok(workspace({ mode })));
    const repo = makeRepo(1, { deadlineAppliedAt: appliedAt });
    renderTable(makeProject({ rows: [row(1, repo)] }));
    const button = await screen.findByRole("button", { name: "Open in workspace" });
    if (held) {
      expect(button).toBeDisabled();
      // The reason is the tooltip of the wrapper that takes the focus.
      fireEvent.focus(button.parentElement!);
      expect(await screen.findByText("After this repository's deadline")).toBeInTheDocument();
    } else {
      expect(button).toBeEnabled();
    }
  });

  it("launches with a POST, stays busy, goes to the portal's address, and never opens the sheet", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const { calls } = routes(ok(workspace()), { [reviewUrl(LIVE.id)]: ok({ url: LAUNCH }) });
    const { onOpen } = renderTable(project());
    const button = await screen.findByRole("button", { name: "Open in workspace" });
    await userEvent.dblClick(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(LAUNCH));
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ url: `${BASE}/repos/${LIVE.id}/workspace/review`, body: null });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each([
    ["review_not_granted", "The online workspace is not enabled for this project's owner: ask an administrator."],
    ["review_archived", "This project or its classroom is archived: the repository no longer opens."],
    ["review_repo_unavailable", "This repository is not available: it is not created yet or was deleted on GitHub."],
    ["review_exam_open", "The exam may still be running: the repository opens once its deadline has passed."],
  ])("words the refusal %s", async (code, text) => {
    routes(ok(workspace()), { [reviewUrl(LIVE.id)]: fail(409, { error: code, message: code }) });
    renderTable(project());
    await userEvent.click(await screen.findByRole("button", { name: "Open in workspace" }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open in workspace" })).toBeEnabled();
  });

  it("says a 404 as the page says any failure", async () => {
    routes(ok(workspace()), { [reviewUrl(LIVE.id)]: fail(404, { error: "not_found" }) });
    renderTable(project());
    await userEvent.click(await screen.findByRole("button", { name: "Open in workspace" }));
    expect(await screen.findByText("This item no longer exists or is not open to you.")).toBeInTheDocument();
  });

  it("speaks French", async () => {
    routes(ok(workspace()));
    renderTable(project(), "fr");
    expect(await screen.findByRole("button", { name: "Ouvrir dans l'espace de travail" })).toBeInTheDocument();
  });
});

describe("Open in workspace, on the sheet", () => {
  it("is a secondary button, with the read-only fact beside it", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    routes(ok(workspace()), { [reviewUrl(LIVE.id)]: ok({ url: LAUNCH }) });
    renderSheet(project());
    const dialog = await screen.findByRole("dialog");
    const button = await within(dialog).findByRole("button", { name: /Open in workspace/ });
    expect(within(dialog).getByText("Read-only. Opening another repository closes the previous one.")).toBeInTheDocument();
    await userEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(LAUNCH));
  });

  it("is held with its reason on a Safe Exam Browser repository whose deadline is not applied", async () => {
    routes(ok(workspace({ mode: "online_seb" })));
    renderSheet(project());
    const button = await screen.findByRole("button", { name: /Open in workspace/ });
    expect(button).toBeDisabled();
  });

  it("is absent on a repository deleted on GitHub", async () => {
    const { calls } = routes(ok(workspace()));
    renderSheet(project(), DELETED.id);
    await screen.findByRole("dialog");
    await waitFor(() => expect(calls.some((c) => c.url === `${BASE}/workspace`)).toBe(true));
    expect(screen.queryByRole("button", { name: /Open in workspace/ })).toBeNull();
  });
});
