import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { NotificationSettings, TeamsLinkPreview } from "@quiz/contracts";

import { makeMe } from "../test/fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { TeamsLinkPage } from "./TeamsLinkPage";

/*
 * The page the HEIG Quiz tab in Teams opens in the browser (ADR-030): which
 * Teams account, which Quiz account, and ONE action — Link.
 */

const TOKEN = "T".repeat(43);
const ROUTE = `/teams/link?token=${TOKEN}`;
const PREVIEW_URL = "POST /app/api/notifications/teams/link/preview";
const preview: TeamsLinkPreview = {
  teamsName: "Léa Rochat (HEIG-VD)",
  teamsUsername: "lea.rochat@heig-vd.ch",
  tenantId: "a372f724-c0b2-4ea0-abfb-0eb8c6f84e40",
  expiresAt: "2026-09-27T12:15:00.000Z",
};
const linked: NotificationSettings = {
  matrix: {
    results_released: { bell: true, email: true, teams: true },
    activity_scheduled: { bell: true, email: false, teams: false },
    activity_available: { bell: true, email: true, teams: true },
    pool_shared: { bell: true, email: true, teams: true },
    pool_ownership: { bell: true, email: true, teams: true },
    student_joined: { bell: true, email: false, teams: false },
    roster_conflict: { bell: true, email: true, teams: true },
    grading_ready: { bell: true, email: true, teams: true },
    pool_question_added: { bell: true, email: false, teams: false },
  },
  email: "marie.dupont@heig-vd.ch",
  teams: {
    available: true,
    linkedAt: "2026-09-27T12:01:00.000Z",
    teamsName: preview.teamsName,
    teamsUsername: preview.teamsUsername,
  },
};

describe("the Teams link page", () => {
  it("names both accounts, and links on the one primary action", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      [PREVIEW_URL]: ok(preview),
      "POST /app/api/notifications/teams/link": ok(linked),
    });
    renderWithProviders(<TeamsLinkPage me={makeMe()} />, { route: ROUTE });

    expect(
      await screen.findByRole("heading", { name: "Link this Teams account to your Quiz account?" }),
    ).toBeVisible();
    expect(screen.getByText("Léa Rochat (HEIG-VD)")).toBeVisible();
    expect(screen.getByText("Microsoft account")).toBeVisible();
    expect(screen.getByText("lea.rochat@heig-vd.ch")).toBeVisible();
    expect(screen.getByText(preview.tenantId)).toBeVisible();
    expect(screen.getByText("Marie Dupont (marie.dupont@heig-vd.ch)")).toBeVisible();
    expect(screen.getByText("Only link a Teams account that is yours.")).toBeVisible();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    // Looking is not linking, and the token travels in a body, never a path.
    const looked = calls.filter((c) => c.method === "POST");
    expect(looked.map((c) => c.url)).toEqual(["/app/api/notifications/teams/link/preview"]);
    expect(looked[0]!.body).toEqual({ token: TOKEN });

    await user.click(screen.getByRole("button", { name: "Link" }));
    expect(await screen.findByRole("heading", { name: "Microsoft Teams is linked" })).toBeVisible();
    expect(calls.find((c) => c.url === "/app/api/notifications/teams/link")?.body).toEqual({ token: TOKEN });
    // The spent token leaves the address bar.
    expect(window.location.search).toBe("");
  });

  it("says a spent or expired link cannot be used, and how to get another", async () => {
    mockFetch({ [PREVIEW_URL]: { status: 404, body: { error: "link_invalid" } } });
    renderWithProviders(<TeamsLinkPage me={makeMe()} />, { route: ROUTE });
    expect(await screen.findByRole("heading", { name: "This link can no longer be used" })).toBeVisible();
    expect(screen.getByText(/Open HEIG Quiz in Teams again/)).toBeVisible();
  });

  it("says the same of a link that lost its token", () => {
    mockFetch({});
    renderWithProviders(<TeamsLinkPage me={makeMe()} />, { route: "/teams/link" });
    expect(screen.getByRole("heading", { name: "This link can no longer be used" })).toBeVisible();
  });

  it("offers a signed-out visitor the sign-in, and asks nothing of the API", async () => {
    const { calls } = mockFetch({ "GET /app/api/config": ok({ devLogin: false }) });
    renderWithProviders(<TeamsLinkPage me={null} />, { route: ROUTE });
    expect(screen.getByRole("heading", { name: "Sign in to link Microsoft Teams" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign in with Switch edu-ID" })).toBeVisible();
    await waitFor(() => expect(calls.some((c) => c.url.includes("/teams/link"))).toBe(false));
  });
});
