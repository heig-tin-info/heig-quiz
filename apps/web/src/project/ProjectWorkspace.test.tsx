import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { ProjectWorkspace as Workspace, ProjectWorkspaceSessions } from "@quiz/contracts";

import { DEVICE_LEVEL_IDS, workSettingBody, workSettingFor, type DeviceLevel } from "@quiz/domain";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { ProjectWorkspace, WorkModeSetting } from "./ProjectWorkspace";

/*
 * The project's online workspace on the staff's page (ADR-047 as amended
 * 2026-10-07, M6-06): absent without the portal, the mode the server lets
 * the caller set, the sync and its Resync, the open workspaces.
 */
const WS = "GET /app/api/projects/p1/workspace";
const SESSIONS = "GET /app/api/projects/p1/workspace/sessions";
const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  mode: "free",
  devices: "any",
  kioskOffered: false,
  allowed: ["free", "online", "online_seb"],
  refusal: null,
  syncedAt: null,
  syncError: null,
  review: true,
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
      lastPushAt: new Date().toISOString(),
      rejectedPush: { ref: "refs/heads/main", at: new Date().toISOString(), reason: "fetch first" },
    },
    {
      sessionId: "s2",
      user: null,
      state: "failed",
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      lastPushAt: null,
      rejectedPush: null,
    },
  ],
};
const render = () =>
  renderWithProviders(
    <>
      <WorkModeSetting projectId="p1" archived={false} />
      <ProjectWorkspace projectId="p1" archived={false} />
    </>,
  );

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
    // Own tools: no device level to choose.
    expect(screen.queryByRole("group", { name: "Allowed devices" })).toBeNull();
    await userEvent.click(within(group).getByText("Online workspace"));
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
    // A push GitHub refused (ADR-078 §6): our sentence, GitHub's reason on hover; on that row only.
    const rejected = screen.getAllByTestId("workspace-push-rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toHaveTextContent("Rejected by GitHub (main)");
    expect(within(rejected[0]!).getByText(/the student must pull/)).toHaveAttribute("title", "fetch first");
  });

  it("keeps the level out of reach once frozen, Online and Own tools alike", async () => {
    mockFetch({
      [WS]: ok(workspace({ mode: "online_seb", devices: "either", kioskOffered: true, allowed: ["online_seb"], refusal: "work_mode_frozen" })),
      [SESSIONS]: ok({ reachable: true, sessions: [] }),
    });
    render();
    const devices = await screen.findByRole("group", { name: "Allowed devices" });
    expect(within(devices).getByRole("radio", { name: /^SEB or kiosk station/ })).toBeChecked();
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
    expect(screen.getByTestId("workspace-refusal")).toHaveTextContent("A workspace was opened");
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

  it("syncs a Safe Exam Browser project like an online one: the Resync is there (D21)", async () => {
    mockFetch({
      [WS]: ok(workspace({ mode: "online_seb", syncedAt: new Date().toISOString() })),
      [SESSIONS]: ok({ reachable: true, sessions: [] }),
    });
    render();
    expect(await screen.findByRole("button", { name: "Resync" })).toBeInTheDocument();
  });
});

/*
 * ADR-089, amendment of 2026-11-15, "One control": under Online, the exam's
 * Allowed devices; Any is `online`, the three others `online_seb` at their
 * level, through the domain's one mapping.
 */
describe("the project's device level", () => {
  const PUT = "PUT /app/api/projects/p1/workspace/mode";
  const NAMES: Record<DeviceLevel, RegExp> = {
    any: /^Any device/,
    seb: /^Safe Exam Browser/,
    either: /^SEB or kiosk station/,
    kiosk: /^Kiosk station only/,
  };
  const at = (level: DeviceLevel, over: Partial<Workspace> = {}) =>
    workspace({ ...workSettingFor(true, level), kioskOffered: true, ...over });
  const pairs = DEVICE_LEVEL_IDS.flatMap((from) => DEVICE_LEVEL_IDS.filter((to) => to !== from).map((to) => [from, to] as const));

  it.each(pairs)("from %s to %s, writes the setting the domain maps the level to", async (from, to) => {
    const { calls } = mockFetch({
      [WS]: ok(at(from)),
      [PUT]: ok(at(to)),
      [SESSIONS]: ok({ reachable: true, sessions: [] }),
      "GET /app/api/projects/p1": ok({}),
    });
    render();
    const devices = await screen.findByRole("group", { name: "Allowed devices" });
    expect(within(devices).getByRole("radio", { name: NAMES[from] })).toBeChecked();
    await userEvent.click(within(devices).getByRole("radio", { name: NAMES[to] }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual(workSettingBody(workSettingFor(true, to))));
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("goes back to own tools from a station level, the level dropped", async () => {
    const { calls } = mockFetch({
      [WS]: ok(at("kiosk")),
      [PUT]: ok(workspace({ kioskOffered: true })),
      [SESSIONS]: ok({ reachable: true, sessions: [] }),
      "GET /app/api/projects/p1": ok({}),
    });
    render();
    const group = await screen.findByRole("radiogroup", { name: "Where students work" });
    await userEvent.click(within(group).getByText("Own tools"));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ mode: "free" }));
  });

  it("offers no station level where the platform does not offer them to projects", async () => {
    mockFetch({ [WS]: ok(at("seb", { kioskOffered: false })), [SESSIONS]: ok({ reachable: true, sessions: [] }) });
    render();
    const devices = await screen.findByRole("group", { name: "Allowed devices" });
    const radios = within(devices).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    [NAMES.any, NAMES.seb].forEach((name, i) => expect(radios[i]).toHaveAccessibleName(name));
  });

  it("keeps a station level in force in sight, flag off, so it can be left", async () => {
    mockFetch({ [WS]: ok(at("kiosk", { kioskOffered: false })), [SESSIONS]: ok({ reachable: true, sessions: [] }) });
    render();
    const devices = await screen.findByRole("group", { name: "Allowed devices" });
    expect(within(devices).getByRole("radio", { name: NAMES.kiosk })).toBeChecked();
    expect(within(devices).queryByRole("radio", { name: NAMES.either })).toBeNull();
  });

  it("words the server's refusal of a station level", async () => {
    mockFetch({
      [WS]: ok(at("seb")),
      [PUT]: fail(422, { error: "kiosk_unavailable" }),
      [SESSIONS]: ok({ reachable: true, sessions: [] }),
    });
    render();
    const devices = await screen.findByRole("group", { name: "Allowed devices" });
    await userEvent.click(within(devices).getByRole("radio", { name: NAMES.kiosk }));
    expect(await screen.findByText("Kiosk stations are not available for projects on this platform.")).toBeInTheDocument();
  });

  it("says what a supervised project hides from its students, in the project's words", async () => {
    mockFetch({ [WS]: ok(at("either")), [SESSIONS]: ok({ reachable: true, sessions: [] }) });
    render();
    expect(await screen.findByText("Students reach their repository only after grading.")).toBeInTheDocument();
    expect(screen.getByText("Only in Safe Exam Browser, launched from the project page.")).toBeInTheDocument();
    expect(screen.getByText("In Safe Exam Browser or on a school kiosk station.")).toBeInTheDocument();
  });
});
