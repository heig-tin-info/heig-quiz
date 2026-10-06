import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GithubClassroom, GithubOrg } from "@quiz/contracts";

import { makeClassroomDetail } from "../test/fixtures";
import { fail, mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { ClassroomGithub } from "./ClassroomGithub";

/*
 * The GitHub section of a classroom's Settings (F-GH-02 to F-GH-04): the
 * connect sheet (org picker, suggested first, the install link), the checks
 * once connected, Disconnect and its 409 while a journal is attached (D28).
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const GITHUB = "/app/api/classrooms/r1/github";
const ORGS = "/app/api/github/orgs";
const INSTALL = "https://github.com/apps/heig-quiz/installations/new?state=r1";

const org = (over: Partial<GithubOrg> & Pick<GithubOrg, "id" | "login">): GithubOrg => ({
  avatarUrl: null,
  installed: true,
  status: "active",
  plan: "team",
  ...over,
});
const TIN = org({ id: "0190d3c4-0000-7000-8000-00000000a001", login: "heig-tin-info" });
const EMB = org({ id: "0190d3c4-0000-7000-8000-00000000a002", login: "heig-emb-lab", plan: "free" });
const GONE = org({ id: "0190d3c4-0000-7000-8000-00000000a003", login: "old-org", installed: false, status: "deleted" });

const plain: GithubClassroom = { link: null, suggestedOrgId: EMB.id, installUrl: INSTALL };
const connected: GithubClassroom = {
  link: { org: TIN, linkedAt: "2026-09-01T00:00:00.000Z", checks: { allRepositories: true, llmSecret: "missing" } },
  suggestedOrgId: null,
  installUrl: INSTALL,
};

function renderSection({ connecting = false, onConnecting = vi.fn(), route = "/" } = {}) {
  renderWithProviders(
    <ClassroomGithub room={makeClassroomDetail()} connecting={connecting} onConnecting={onConnecting} />,
    { route },
  );
  return onConnecting;
}

describe("the classroom's GitHub section", () => {
  it("offers Connect to GitHub, the tab's one primary, on a classroom not connected", async () => {
    mockFetch({ [`GET ${GITHUB}`]: ok(plain) });
    const onConnecting = renderSection();
    expect(await screen.findByText("Not connected")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Connect to GitHub" }));
    expect(onConnecting).toHaveBeenCalledWith(true);
  });

  it("draws nothing on a platform without Quiz's App (404)", async () => {
    const { calls } = mockFetch({});
    renderSection();
    await waitFor(() => expect(calls.some((c) => c.url === GITHUB)).toBe(true));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "GitHub" })).toBeNull());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("connects to the suggested organization, preselected and listed first", async () => {
    const { calls } = mockFetch({
      [`GET ${GITHUB}`]: ok(plain),
      [`GET ${ORGS}`]: ok([TIN, GONE, EMB]),
      [`PUT ${GITHUB}`]: ok({ ...connected, link: { ...connected.link!, org: EMB } }),
    });
    const onConnecting = renderSection({ connecting: true });
    const sheet = await screen.findByRole("dialog", { name: "Connect this classroom to GitHub" });
    const radios = await within(sheet).findAllByRole("radio");
    expect(radios.map((r) => r.closest("label")!.textContent)).toEqual([
      expect.stringContaining("heig-emb-lab"),
      expect.stringContaining("heig-tin-info"),
      expect.stringContaining("old-org"),
    ]);
    expect(radios[0]).toBeChecked();
    // An organization gone from GitHub cannot be picked.
    expect(radios[2]).toBeDisabled();
    // The install link leaves in the same tab, on the classroom's state.
    const install = within(sheet).getByRole("link", { name: /Install the App on GitHub/ });
    expect(install).toHaveAttribute("href", INSTALL);
    expect(install).not.toHaveAttribute("target");

    await userEvent.click(within(sheet).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ orgId: EMB.id }));
    expect(await screen.findByText("Classroom connected to heig-emb-lab.")).toBeVisible();
    expect(onConnecting).toHaveBeenCalledWith(false);
  });

  it("preselects the organization the setup return names, once, and takes it out of the address", async () => {
    const { calls } = mockFetch({
      [`GET ${GITHUB}`]: ok(plain),
      [`GET ${ORGS}`]: ok([TIN, EMB]),
      [`PUT ${GITHUB}`]: ok(connected),
    });
    renderSection({ connecting: true, route: `/classrooms/r1/settings?connect=1&installed=${TIN.id}` });
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText("Installed on heig-tin-info.")).toBeVisible();
    expect(within(sheet).getByRole("radio", { name: /heig-tin-info/ })).toBeChecked();
    expect(window.location.search).toBe("?connect=1");
    await userEvent.click(within(sheet).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ orgId: TIN.id }));
  });

  it("ignores an `installed` that is not a selectable organization of the list", async () => {
    for (const installed of [GONE.id, "0190d3c4-0000-7000-8000-00000000ffff"]) {
      mockFetch({ [`GET ${GITHUB}`]: ok(plain), [`GET ${ORGS}`]: ok([TIN, GONE, EMB]) });
      const { unmount } = renderWithProviders(
        <ClassroomGithub room={makeClassroomDetail()} connecting onConnecting={vi.fn()} />,
        { route: `/classrooms/r1/settings?connect=1&installed=${installed}` },
      );
      const sheet = await screen.findByRole("dialog");
      await within(sheet).findAllByRole("radio");
      expect(within(sheet).queryByText(/Installed on/)).toBeNull();
      // The suggested organization stays the pick.
      expect(within(sheet).getByRole("radio", { name: /heig-emb-lab/ })).toBeChecked();
      unmount();
    }
  });

  it("drops a stale connect sheet request on a connected classroom", async () => {
    mockFetch({ [`GET ${GITHUB}`]: ok(connected) });
    const onConnecting = renderSection({
      connecting: true,
      route: `/classrooms/r1/settings?connect=1&installed=${TIN.id}`,
    });
    await screen.findByRole("list", { name: "Checks" });
    await waitFor(() => expect(onConnecting).toHaveBeenCalledWith(false));
    expect(window.location.search).toBe("?connect=1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("links the installation fix in the same tab", async () => {
    mockFetch({ [`GET ${GITHUB}`]: ok({ ...connected, link: { ...connected.link!, org: { ...TIN, installed: false } } }) });
    renderSection();
    const fix = await screen.findByRole("link", { name: /Open on GitHub/ });
    expect(fix).toHaveAttribute("href", INSTALL);
    expect(fix).not.toHaveAttribute("target");
  });

  it("links the free-plan check to GitHub Education, in a new tab", async () => {
    mockFetch({
      [`GET ${GITHUB}`]: ok({ ...connected, link: { ...connected.link!, org: EMB } }),
    });
    renderSection();
    const link = await screen.findByRole("link", { name: /Upgrade with GitHub Education/ });
    expect(link).toHaveAttribute("href", "https://education.github.com/globalcampus/teacher");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("reports a refused connect once, under the list", async () => {
    mockFetch({
      [`GET ${GITHUB}`]: ok(plain),
      [`GET ${ORGS}`]: ok([EMB]),
      [`PUT ${GITHUB}`]: fail(409, { error: "app_not_installed", message: "not installed" }),
    });
    renderSection({ connecting: true });
    const sheet = await screen.findByRole("dialog");
    await within(sheet).findAllByRole("radio");
    await userEvent.click(within(sheet).getByRole("button", { name: "Connect" }));
    expect(await screen.findAllByText(/is not installed on this organization/)).toHaveLength(1);
  });

  it("keeps Connect disabled until an organization is picked, and sends the one picked", async () => {
    const { calls } = mockFetch({
      [`GET ${GITHUB}`]: ok({ ...plain, suggestedOrgId: null }),
      [`GET ${ORGS}`]: ok([TIN, EMB]),
      [`PUT ${GITHUB}`]: ok(connected),
    });
    renderSection({ connecting: true });
    const sheet = await screen.findByRole("dialog");
    await within(sheet).findAllByRole("radio");
    expect(within(sheet).getByRole("button", { name: "Connect" })).toBeDisabled();
    await userEvent.click(within(sheet).getByRole("radio", { name: /heig-tin-info/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ orgId: TIN.id }));
  });

  it("shows the organization and the worded checks once connected, and no primary", async () => {
    mockFetch({ [`GET ${GITHUB}`]: ok(connected) });
    renderSection();
    expect(await screen.findByText("heig-tin-info")).toBeVisible();
    const checks = screen.getByRole("list", { name: "Checks" });
    const lines = within(checks).getAllByRole("listitem");
    expect(lines.map((l) => l.getAttribute("data-level"))).toEqual(["ok", "ok", "warning"]);
    expect(lines[0]).toHaveTextContent("App installed, with access to all repositories.");
    expect(lines[1]).toHaveTextContent("Plan: team.");
    expect(lines[2]).toHaveTextContent("No ANTHROPIC_API_KEY organization secret");
    expect(within(lines[2]!).getByRole("img", { name: "Warning" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect to GitHub" })).toBeNull();
  });

  it("disconnects after a confirmation", async () => {
    const { calls } = mockFetch({ [`GET ${GITHUB}`]: ok(connected), [`DELETE ${GITHUB}`]: noContent() });
    renderSection();
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Nothing is deleted on GitHub");
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === GITHUB)).toBe(true));
    expect(await screen.findByText("Classroom disconnected from GitHub.")).toBeVisible();
  });

  it("says to remove the journal first when a disconnect is refused 409 journal_attached", async () => {
    mockFetch({
      [`GET ${GITHUB}`]: ok(connected),
      [`DELETE ${GITHUB}`]: fail(409, { error: "journal_attached", message: "The classroom has a journal" }),
    });
    renderSection();
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Disconnect" }));
    const alert = await screen.findByText(/remove the journal first/);
    expect(alert).toBeVisible();
    // Worded by the SPA, never the server's English.
    expect(screen.queryByText("The classroom has a journal")).toBeNull();
  });
});
