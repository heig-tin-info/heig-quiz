import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { ProjectWorkspace as Workspace, ProjectWorkspaceSessions } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { ProjectWorkspace } from "./ProjectWorkspace";

/*
 * The project's online workspace on the staff's page (ADR-047 as amended
 * 2026-10-07, M6-06): absent without the portal, the mode the server lets
 * the caller set, the sync and its Resync, the open workspaces.
 */
const WS = "GET /app/api/projects/p1/workspace";
const SESSIONS = "GET /app/api/projects/p1/workspace/sessions";
const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  mode: "free",
  allowed: ["free", "online", "online_seb"],
  refusal: null,
  syncedAt: null,
  syncError: null,
  ...over,
});
const sessions: ProjectWorkspaceSessions = {
  reachable: true,
  sessions: [
    {
      sessionId: "s1",
      user: { id: "0190d3c4-0000-7000-8000-000000000001", name: "Léa Perret" },
      state: "running",
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      lastPushAt: null,
    },
    {
      sessionId: "s2",
      user: null,
      state: "failed",
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      lastPushAt: null,
    },
  ],
};
const render = () => renderWithProviders(<ProjectWorkspace projectId="p1" archived={false} />);

describe("the project's workspace section", () => {
  it("is not there at all on a platform without the portal (the route's 404)", async () => {
    const { calls } = mockFetch({ [WS]: fail(404, { error: "not_found" }) });
    const { container } = render();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await waitFor(() => expect(container.querySelector("[data-testid=project-workspace]")).toBeNull());
    expect(screen.queryByText("Workspace")).toBeNull();
  });

  it("sets the mode an owner with the grant may choose", async () => {
    const { calls } = mockFetch({
      [WS]: ok(workspace()),
      "PUT /app/api/projects/p1/workspace/mode": ok(workspace({ mode: "online", syncedAt: new Date().toISOString() })),
      [SESSIONS]: ok({ reachable: true, sessions: [] }),
      "GET /app/api/projects/p1": ok({}),
    });
    render();
    const group = await screen.findByRole("radiogroup", { name: "Where students work" });
    await userEvent.click(within(group).getByText("Online"));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ mode: "online" }));
    expect(await screen.findByText(/^Workspace updated/)).toBeInTheDocument();
    expect(await screen.findByText("No student has opened a workspace yet.")).toBeInTheDocument();
  });

  it("says why the mode cannot change, the selector disabled", async () => {
    mockFetch({
      [WS]: ok(workspace({ mode: "online", allowed: ["online"], refusal: "work_mode_frozen", syncedAt: new Date().toISOString() })),
      [SESSIONS]: ok(sessions),
    });
    render();
    expect(await screen.findByText("A workspace was opened: where students work can no longer change.")).toBeInTheDocument();
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
    // The open workspaces: a student by name, an account the classroom does not hold by no name nor address.
    expect(await screen.findByText("Léa Perret")).toBeInTheDocument();
    expect(screen.getByText("Not in this classroom")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("shows the last sync's failure, and resyncs on request", async () => {
    const { calls } = mockFetch({
      [WS]: ok(workspace({ mode: "online", syncError: "portal answered 503: down" })),
      [SESSIONS]: ok({ reachable: false, sessions: [] }),
      "POST /app/api/projects/p1/workspace/sync": ok({ requestedAt: new Date().toISOString() }),
    });
    render();
    expect(await screen.findByText("The workspace could not be updated")).toBeInTheDocument();
    // Our sentence; the portal's words only as the technical detail on hover.
    expect(screen.getByTestId("workspace-sync-error")).toHaveTextContent(/did not reach the workspace/);
    expect(screen.getByTestId("workspace-sync-error")).toHaveAttribute("title", "portal answered 503: down");
    expect(screen.queryByText("portal answered 503: down")).toBeNull();
    expect(await screen.findByText(/The workspace portal cannot be reached right now/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Resync" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/app/api/projects/p1/workspace/sync")).toBe(true));
  });
});
