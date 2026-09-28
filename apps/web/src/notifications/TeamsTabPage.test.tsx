import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { TeamsTabState } from "@quiz/contracts";

import { mockFetch, ok, renderWithProviders } from "../test/render";
import { tabTargetRoute, TeamsTabPage } from "./TeamsTabPage";
import type { TeamsHost } from "./teamsHost";

/*
 * The HEIG Quiz tab inside Teams (ADR-030), with the Teams client replaced
 * by a fake host: no session, the SSO token sent to the tab endpoint, and
 * ONE primary action per state.
 */

const TAB = "POST /app/api/notifications/teams/tab";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const LINK_URL = `http://localhost:3000/teams/link?token=${"T".repeat(43)}`;

function fakeHost(over: Partial<TeamsHost> = {}) {
  const host: TeamsHost = {
    subPageId: undefined,
    getAuthToken: vi.fn(async () => "sso.token.value"),
    openLink: vi.fn(async () => {}),
    ...over,
  };
  return { host, connect: async () => host };
}

describe("the Teams tab", () => {
  it("says to open it from Teams when it is not inside Teams, and asks the API nothing", async () => {
    const { calls } = mockFetch({});
    renderWithProviders(<TeamsTabPage connect={async () => null} />, { route: "/teams" });
    expect(await screen.findByRole("heading", { name: "Open HEIG Quiz in Teams" })).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("sends the SSO token, and opens the link in the browser for an unlinked account", async () => {
    const user = userEvent.setup();
    const { calls, fetchMock } = mockFetch({ [TAB]: ok({ state: "unlinked", linkUrl: LINK_URL } satisfies TeamsTabState) });
    const { host, connect } = fakeHost();
    renderWithProviders(<TeamsTabPage connect={connect} />, { route: "/teams" });

    expect(await screen.findByRole("heading", { name: "Link Teams to your Quiz account" })).toBeVisible();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([TAB]);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sso.token.value");
    expect(screen.getByText("The link works once, for 15 minutes.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Link to my Quiz account" }));
    expect(host.openLink).toHaveBeenCalledWith(LINK_URL);

    await user.click(screen.getByRole("button", { name: "I linked it: check again" }));
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it("names the linked Quiz account", async () => {
    mockFetch({ [TAB]: ok({ state: "linked", accountName: "Léa Rochat" } satisfies TeamsTabState) });
    const { host, connect } = fakeHost();
    const user = userEvent.setup();
    renderWithProviders(<TeamsTabPage connect={connect} />, { route: "/teams" });
    expect(await screen.findByRole("heading", { name: "Linked to the Quiz account of Léa Rochat" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open HEIG Quiz in the browser" }));
    expect(host.openLink).toHaveBeenCalledWith(`${window.location.origin}/settings`);
  });

  it("opens the page a notification leads to, from its structured target", async () => {
    mockFetch({ [TAB]: ok({ state: "linked", accountName: "Léa Rochat" } satisfies TeamsTabState) });
    const { host, connect } = fakeHost({ subPageId: JSON.stringify({ kind: "feedback", attemptId: ATTEMPT }) });
    const user = userEvent.setup();
    renderWithProviders(<TeamsTabPage connect={connect} />, { route: "/teams" });
    expect(await screen.findByRole("heading", { name: "This notification opens in HEIG Quiz" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open in the browser" }));
    expect(host.openLink).toHaveBeenCalledWith(`${window.location.origin}/attempts/${ATTEMPT}/feedback`);
  });

  it("shows Teams' error code when the SSO fails, and tries again", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({ [TAB]: ok({ state: "linked", accountName: "Léa" } satisfies TeamsTabState) });
    let fail = true;
    const { connect } = fakeHost({
      getAuthToken: async () => {
        if (fail) throw new Error("resourceRequiresConsent");
        return "sso.token.value";
      },
    });
    renderWithProviders(<TeamsTabPage connect={connect} />, { route: "/teams" });
    expect(await screen.findByRole("heading", { name: "Teams could not sign you in" })).toBeVisible();
    expect(screen.getByText("resourceRequiresConsent")).toBeVisible();
    expect(calls).toHaveLength(0);
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Linked to the Quiz account of Léa" })).toBeVisible();
  });

  it("says why an account of another organization cannot be linked", async () => {
    mockFetch({ [TAB]: { status: 403, body: { error: "tenant_not_allowed" } } });
    renderWithProviders(<TeamsTabPage connect={fakeHost().connect} />, { route: "/teams" });
    expect(await screen.findByRole("heading", { name: "This organization cannot be linked" })).toBeVisible();
  });
});

describe("the target of a notification", () => {
  it("becomes a path of the app, or nothing", () => {
    expect(tabTargetRoute(JSON.stringify({ kind: "feedback", attemptId: ATTEMPT }))).toEqual({
      view: "feedback",
      attemptId: ATTEMPT,
    });
    const pool = "11111111-1111-4111-8111-111111111111";
    expect(tabTargetRoute(JSON.stringify({ kind: "pool", poolId: pool }))).toEqual({ view: "pool", id: pool });
    for (const hostile of [
      undefined,
      "",
      "not json",
      "/admin",
      "https://evil.example/",
      JSON.stringify({ kind: "feedback", attemptId: "../../admin" }),
      JSON.stringify({ kind: "url", url: "https://evil.example/" }),
      JSON.stringify({ kind: "pool", poolId: "//evil.example" }),
    ]) {
      expect(tabTargetRoute(hostile), String(hostile)).toBeNull();
    }
  });
});
