import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { GithubClassroom } from "@quiz/contracts";

import { ClassroomView } from "../ClassroomView";
import { makeClassroomDetail } from "../test/fixtures";
import { fail, mockFetch, ok, renderWithProviders, type Reply } from "../test/render";

/*
 * "New ▾" (M3-10): the classroom's one primary on its activities tab, and
 * the GitHub gate of Project — absent without Quiz's App, the Settings'
 * connect sheet on a classroom not connected, the new project on a
 * connected one.
 */

const ROOM = "/app/api/classrooms/r1";
const INSTALL = "https://github.com/apps/heig-quiz/installations/new?state=r1";
const plain: GithubClassroom = { link: null, suggestedOrgId: null, installUrl: INSTALL };
const connected: GithubClassroom = {
  link: {
    org: {
      id: "0190d3c4-0000-7000-8000-00000000a001",
      login: "heig-tin-info",
      avatarUrl: null,
      installed: true,
      status: "active",
      plan: "team",
    },
    linkedAt: "2026-09-01T00:00:00.000Z",
    checks: { allRepositories: true, llmSecret: "present" },
  },
  suggestedOrgId: null,
  installUrl: INSTALL,
};

function renderClassroom(github?: Reply | (() => Reply)) {
  const navigate = vi.fn();
  mockFetch({
    [`GET ${ROOM}`]: ok(makeClassroomDetail()),
    [`GET ${ROOM}/evaluations`]: ok([]),
    [`GET ${ROOM}/projects`]: ok([]),
    ...(github ? { [`GET ${ROOM}/github`]: github } : {}),
  });
  renderWithProviders(<ClassroomView id="r1" navigate={navigate} />);
  return navigate;
}

/** Opens "New ▾" and returns its menu. */
async function openNew() {
  await userEvent.click(await screen.findByRole("button", { name: /^New$/ }));
  return screen.findByRole("menu");
}

describe("New ▾ on the classroom's activities", () => {
  it("is the plain New evaluation on a platform without Quiz's App", async () => {
    // No GitHub route stubbed: the 404 of a platform without the App.
    renderClassroom();
    await screen.findByText("No evaluation yet");
    await waitFor(() => expect(screen.queryByRole("button", { name: /^New$/ })).toBeNull());
    // The header's and the empty state's, the same flow.
    expect(screen.getAllByRole("button", { name: /New evaluation/ })).toHaveLength(2);
  });

  it("leaves Project out when the GitHub read fails, rather than guess", async () => {
    renderClassroom(fail(500, { message: "boom" }));
    await screen.findByText("No evaluation yet");
    await waitFor(() => expect(screen.getAllByRole("button", { name: /New evaluation/ })).toHaveLength(2));
    expect(screen.queryByRole("button", { name: /^New$/ })).toBeNull();
  });

  it("opens the evaluation dialog from its Evaluation item", async () => {
    renderClassroom(ok(connected));
    const menu = await openNew();
    await userEvent.click(within(menu).getByRole("menuitem", { name: /Evaluation/ }));
    expect(await screen.findByRole("dialog", { name: "New evaluation" })).toBeVisible();
  });

  it("sends an unconnected classroom to the Settings' connect sheet, and says why", async () => {
    const navigate = renderClassroom(ok(plain));
    const menu = await openNew();
    const project = within(menu).getByRole("menuitem", { name: /Project/ });
    expect(project).toHaveTextContent("Connect this classroom to GitHub first");
    await userEvent.click(project);
    expect(navigate).toHaveBeenCalledWith({ view: "classroomSettings", id: "r1" });
    expect(new URLSearchParams(window.location.search).get("connect")).toBe("1");
  });

  it("opens the new project on a connected classroom", async () => {
    const navigate = renderClassroom(ok(connected));
    const menu = await openNew();
    const project = within(menu).getByRole("menuitem", { name: /Project/ });
    expect(project).not.toHaveTextContent("GitHub");
    await userEvent.click(project);
    expect(navigate).toHaveBeenCalledWith({ view: "projectNew", classroomId: "r1" });
  });

  it("is the plain New evaluation while the link is not known yet: no menu that turns back", async () => {
    // Never answers: the read is still loading.
    const navigate = vi.fn();
    mockFetch({
      [`GET ${ROOM}`]: ok(makeClassroomDetail()),
      [`GET ${ROOM}/evaluations`]: ok([]),
    });
    const fetchMock = vi.mocked(fetch);
    const answer = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) =>
      String(input).endsWith("/github") ? new Promise<Response>(() => {}) : answer(input, init),
    );
    renderWithProviders(<ClassroomView id="r1" navigate={navigate} />);
    await screen.findByText("No evaluation yet");
    expect(screen.getAllByRole("button", { name: /New evaluation/ })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /^New$/ })).toBeNull();
  });

  it("speaks French", async () => {
    mockFetch({
      [`GET ${ROOM}`]: ok(makeClassroomDetail()),
      [`GET ${ROOM}/evaluations`]: ok([]),
      [`GET ${ROOM}/github`]: ok(plain),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { locale: "fr" });
    await userEvent.click(await screen.findByRole("button", { name: /^Nouveau$/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Projet/ })).toHaveTextContent(
      "Connectez d'abord cette classe à GitHub",
    );
  });
});
