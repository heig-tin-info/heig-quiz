import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GithubClassroom, GithubOrg } from "@quiz/contracts";

import { makeClassroomDetail } from "../test/fixtures";
import { fail, mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { githubOrgsKey } from "../queryKeys";
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

function renderSection({ connecting = false, onConnecting = vi.fn() } = {}) {
  renderWithProviders(
    <ClassroomGithub room={makeClassroomDetail()} connecting={connecting} onConnecting={onConnecting} />,
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
    // The install link opens GitHub in a new tab, on the classroom's state.
    const install = within(sheet).getByRole("link", { name: /Install the App on GitHub/ });
    expect(install).toHaveAttribute("href", INSTALL);
    expect(install).toHaveAttribute("target", "_blank");

    await userEvent.click(within(sheet).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ orgId: EMB.id }));
    expect(await screen.findByText("Classroom connected to heig-emb-lab.")).toBeVisible();
    expect(onConnecting).toHaveBeenCalledWith(false);
  });

  it("picks the organization an install adds, once the list is read again", async () => {
    let lists = 0;
    const { calls } = mockFetch({
      [`GET ${GITHUB}`]: ok(plain),
      [`GET ${ORGS}`]: () => ok(lists++ === 0 ? [TIN] : [TIN, EMB]),
      [`PUT ${GITHUB}`]: ok(connected),
    });
    const { queryClient } = renderWithProviders(
      <ClassroomGithub room={makeClassroomDetail()} connecting onConnecting={vi.fn()} />,
    );
    const sheet = await screen.findByRole("dialog");
    await within(sheet).findAllByRole("radio");
    await userEvent.click(within(sheet).getByRole("link", { name: /Install the App on GitHub/ }));
    expect(within(sheet).getByRole("progressbar")).toBeInTheDocument();

    // The setup return's `classrooms` hint refetches the list.
    await queryClient.invalidateQueries({ queryKey: githubOrgsKey });
    expect(await within(sheet).findByText("Installed on heig-emb-lab.")).toBeVisible();
    expect(within(sheet).getByRole("radio", { name: /heig-emb-lab/ })).toBeChecked();
    expect(within(sheet).queryByRole("progressbar")).toBeNull();
    await userEvent.click(within(sheet).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ orgId: EMB.id }));
  });

  it("stops waiting once the list is read again, even with nothing new", async () => {
    mockFetch({ [`GET ${GITHUB}`]: ok(plain), [`GET ${ORGS}`]: ok([TIN, EMB]) });
    const { queryClient } = renderWithProviders(
      <ClassroomGithub room={makeClassroomDetail()} connecting onConnecting={vi.fn()} />,
    );
    const sheet = await screen.findByRole("dialog");
    await within(sheet).findAllByRole("radio");
    await userEvent.click(within(sheet).getByRole("link", { name: /Install the App on GitHub/ }));
    expect(within(sheet).getByRole("progressbar")).toBeInTheDocument();
    await queryClient.invalidateQueries({ queryKey: githubOrgsKey });
    await waitFor(() => expect(within(sheet).queryByRole("progressbar")).toBeNull());
    expect(within(sheet).queryByText(/Installed on/)).toBeNull();
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
