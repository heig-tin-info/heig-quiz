import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StudentProject } from "@quiz/contracts";

import { fail, mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { KIOSK_RETRY_MS } from "./useKioskStation";
import { StationProjectPage } from "./StationProjectPage";

/*
 * ADR-089 §3, §4, §7, §8: a station's project sitting. The bar (the
 * station's label, the server's deadline, Leave), the portal in a sandboxed
 * frame from the start route's `{ url }`, the suspension covering it, the
 * relaunch before the portal's cookie runs out, the return to `/kiosk`.
 */

const START = "POST /app/api/projects/p1/workspace/start";
const LEAVE = "POST /app/api/kiosk/leave";
const PORTAL = "https://code.example.ch/launch?token=t1";
const NOW = Date.now();

const project = {
  kind: "project",
  seat: "student",
  workspace: { mode: "online_seb", devices: "kiosk" },
  id: "p1",
  title: "Mini-projet — Jeu de la vie",
  classroomId: "r1",
  classroomName: "PRG1-2026",
  courseCode: "PRG1",
  startAt: new Date(NOW - 86_400_000).toISOString(),
  deadlineAt: new Date(NOW + 2 * 3_600_000).toISOString(),
  status: "in_progress",
  githubLinked: true,
  gradingMode: "auto",
  criteria: null,
  repo: null,
  release: null,
  serverNow: new Date(NOW).toISOString(),
} as unknown as StudentProject;

const VERIFY = "POST /app/api/kiosk/attest/verify";
const STATION = {
  "GET /app/api/config": ok({ devLogin: false, kiosk: { extensionId: null, mock: true } }),
  "POST /app/api/kiosk/attest/challenge": ok({ challenge: "Yw==" }),
  [VERIFY]: ok({ station: { label: "Poste n° 7", status: "active" } }),
  "GET /app/api/kiosk/station": ok({ label: "Poste n° 7", status: "active" }),
  "GET /app/api/student/projects/p1": ok(project),
  "GET /app/api/me": ok({}),
};

const starts = (calls: { method: string; url: string }[]) =>
  calls.filter((c) => c.method === "POST" && c.url === "/app/api/projects/p1/workspace/start").length;
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const frame = () => document.querySelector("iframe");

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the station page of a project", () => {
  it("frames the start route's address, sandboxed, under the station's bar", async () => {
    const { calls } = mockFetch({ ...STATION, [START]: ok({ url: PORTAL }) });
    renderWithProviders(<StationProjectPage id="p1" />);
    await waitFor(() => expect(frame()).not.toBeNull());
    const iframe = frame()!;
    expect(iframe).toHaveAttribute("src", PORTAL);
    expect(iframe).toHaveAttribute("allow", "clipboard-read; clipboard-write");
    const sandbox = iframe.getAttribute("sandbox")!.split(" ");
    expect(sandbox).toEqual(expect.arrayContaining(["allow-scripts", "allow-same-origin"]));
    // Nothing the portal serves takes the station off the page.
    for (const token of sandbox) expect(token).not.toMatch(/top-navigation|popups/);
    expect(iframe).not.toHaveAttribute("inert");
    expect(starts(calls)).toBe(1);
    expect(await screen.findByTestId("station-label")).toHaveTextContent("Poste n° 7");
    expect(screen.getByText("Mini-projet — Jeu de la vie")).toBeInTheDocument();
    // The server's deadline, two hours away.
    expect(screen.getByRole("timer")).toHaveAccessibleName(/^(1\sh\s59|2\sh\s00)\smin\s\d\d\ss\sremaining$/);
    expect(screen.getByRole("button", { name: "Leave this station" })).toBeInTheDocument();
  });

  it("re-attests and launches again when the server finds the station's check stale", async () => {
    let asked = 0;
    const { calls } = mockFetch({
      ...STATION,
      [START]: () => (++asked === 1 ? fail(423, { error: "kiosk_attestation_stale" }) : ok({ url: PORTAL })),
    });
    renderWithProviders(<StationProjectPage id="p1" />);
    await waitFor(() => expect(frame()).toHaveAttribute("src", PORTAL));
    expect(starts(calls)).toBe(2);
  });

  it("covers the page while suspended, and launches once an attestation lifts it", async () => {
    let asked = 0;
    let verified = 0;
    const { calls } = mockFetch({
      ...STATION,
      // Google cannot answer at first (no verdict either way), then the station is attested.
      [VERIFY]: () =>
        ++verified === 1
          ? fail(503, { error: "attestation_unavailable" })
          : ok({ station: { label: "Poste n° 7", status: "active" } }),
      [START]: () => (++asked === 1 ? fail(423, { error: "kiosk_suspended" }) : ok({ url: PORTAL })),
    });
    renderWithProviders(<StationProjectPage id="p1" />);
    expect(await screen.findByText("This station is suspended")).toBeInTheDocument();
    expect(screen.getByText(/The workspace comes back once the station is checked again/)).toBeInTheDocument();
    expect(frame()).toBeNull();
    await advance(KIOSK_RETRY_MS);
    await waitFor(() => expect(frame()).toHaveAttribute("src", PORTAL));
    expect(screen.queryByText("This station is suspended")).toBeNull();
    expect(starts(calls)).toBe(2);
  });

  it("covers the frame as soon as one of its attestations is refused, the frame out of reach", async () => {
    mockFetch({ ...STATION, [VERIFY]: fail(403, { error: "not_attested" }), [START]: ok({ url: PORTAL }) });
    renderWithProviders(<StationProjectPage id="p1" />);
    expect(await screen.findByText("This station is suspended")).toBeInTheDocument();
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(frame()).toHaveAttribute("inert");
  });

  it("relaunches before the portal's cookie runs out, from the same route", async () => {
    let asked = 0;
    const { calls } = mockFetch({ ...STATION, [START]: () => ok({ url: `${PORTAL}${++asked}` }) });
    renderWithProviders(<StationProjectPage id="p1" relaunchMs={60_000} />);
    await waitFor(() => expect(frame()).toHaveAttribute("src", `${PORTAL}1`));
    await advance(59_000);
    expect(starts(calls)).toBe(1);
    await advance(1_000);
    await waitFor(() => expect(frame()).toHaveAttribute("src", `${PORTAL}2`));
    expect(starts(calls)).toBe(2);
  });

  it("says a refusal the student can read, with no frame", async () => {
    mockFetch({ ...STATION, [START]: fail(409, { error: "closed" }) });
    renderWithProviders(<StationProjectPage id="p1" />);
    expect(await screen.findByText("The deadline has passed: the workspace no longer opens.")).toBeInTheDocument();
    expect(frame()).toBeNull();
  });

  it("offers a retry when the launch failed otherwise", async () => {
    let asked = 0;
    const { calls } = mockFetch({ ...STATION, [START]: () => (++asked === 1 ? fail(502) : ok({ url: PORTAL })) });
    renderWithProviders(<StationProjectPage id="p1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(frame()).toHaveAttribute("src", PORTAL));
    expect(starts(calls)).toBe(2);
  });

  it("asks before leaving, ends the sitting on the server, then goes back to the station's screen", async () => {
    const { calls } = mockFetch({ ...STATION, [START]: ok({ url: PORTAL }), [LEAVE]: noContent() });
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace });
    renderWithProviders(<StationProjectPage id="p1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Leave this station" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave this station?" });
    expect(dialog).toHaveTextContent("The project is graded from your repository at the deadline.");
    await userEvent.click(screen.getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/kiosk"));
    expect(calls.filter((c) => c.method === "POST" && c.url === "/app/api/kiosk/leave")).toHaveLength(1);
  });

  it("goes back to the station's screen when the sitting had already ended (404)", async () => {
    mockFetch({ ...STATION, [START]: ok({ url: PORTAL }), [LEAVE]: fail(404, { error: "not_found" }) });
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace });
    renderWithProviders(<StationProjectPage id="p1" />);
    await confirmLeave();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/kiosk"));
  });

  it("stays on the sitting and says so when Leave failed", async () => {
    mockFetch({ ...STATION, [START]: ok({ url: PORTAL }), [LEAVE]: fail(502) });
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace });
    renderWithProviders(<StationProjectPage id="p1" />);
    await confirmLeave();
    expect(await screen.findByText("Could not leave this station. Try again, or call the supervisor.")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(frame()).toHaveAttribute("src", PORTAL);
    expect(screen.getByRole("button", { name: "Leave this station" })).toBeEnabled();
  });

  it("stays on the sitting under the suspension notice when the station is suspended (423)", async () => {
    mockFetch({ ...STATION, [START]: ok({ url: PORTAL }), [LEAVE]: fail(423, { error: "kiosk_suspended" }) });
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace });
    renderWithProviders(<StationProjectPage id="p1" />);
    await confirmLeave();
    expect(await screen.findByText("This station is suspended")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText(/Could not leave this station/)).toBeNull();
  });
});

async function confirmLeave() {
  await waitFor(() => expect(frame()).toHaveAttribute("src", PORTAL));
  await userEvent.click(screen.getByRole("button", { name: "Leave this station" }));
  await screen.findByRole("dialog", { name: "Leave this station?" });
  await userEvent.click(screen.getByRole("button", { name: "Leave" }));
}
