import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { DistributionRepo } from "./DistributionAccess";

/*
 * The distribution repository's access on demand (#899): a button for a
 * caller with a linked account, a note leading to Settings without one, and
 * what GitHub answered once clicked.
 */

const ID = "11111111-1111-4111-8111-111111111111";
const FULL = "heig-org/lab-squashed";
const ACCESS = `POST /app/api/projects/${ID}/distribution/access`;
const linked = ok({ account: { login: "ychevallier", linkedAt: "2026-09-01T08:00:00.000Z" }, relevant: true });

afterEach(() => vi.unstubAllGlobals());

describe("DistributionRepo", () => {
  it("offers Request access, then says the invitation was sent with a link to GitHub", async () => {
    const { calls } = mockFetch({
      "GET /app/api/me/github": linked,
      [ACCESS]: ok({ status: "pending", invitationsUrl: `https://github.com/${FULL}/invitations` }),
    });
    renderWithProviders(<DistributionRepo projectId={ID} fullName={FULL} />);
    await userEvent.click(await screen.findByRole("button", { name: "Request access" }));
    const invited = await screen.findByTestId("distribution-invited");
    expect(invited).toHaveTextContent("Invitation sent, accept it on GitHub");
    expect(invited).toHaveAttribute("href", `https://github.com/${FULL}/invitations`);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Request access" })).toBeNull();
  });

  it("says the caller already has access", async () => {
    mockFetch({
      "GET /app/api/me/github": linked,
      [ACCESS]: ok({ status: "accepted", invitationsUrl: `https://github.com/${FULL}/invitations` }),
    });
    renderWithProviders(<DistributionRepo projectId={ID} fullName={FULL} />);
    await userEvent.click(await screen.findByRole("button", { name: "Request access" }));
    expect(await screen.findByTestId("distribution-in")).toHaveTextContent("You have access");
  });

  it("shows a note leading to Settings instead of the button without a linked account", async () => {
    mockFetch({ "GET /app/api/me/github": ok({ account: null, relevant: true }) });
    renderWithProviders(<DistributionRepo projectId={ID} fullName={FULL} />);
    const note = await screen.findByTestId("distribution-link-first");
    expect(note).toHaveTextContent("Link GitHub in Settings to open it");
    expect(note).toHaveAttribute("href", "/settings");
    expect(screen.queryByRole("button", { name: "Request access" })).toBeNull();
    // The repository's link stays.
    expect(screen.getByRole("link", { name: "lab-squashed" })).toBeInTheDocument();
  });

  it("words GitHub's failure under the button, which stays", async () => {
    mockFetch({
      "GET /app/api/me/github": linked,
      [ACCESS]: fail(502, { error: "invite_failed", message: "GitHub did not take the invitation" }),
    });
    renderWithProviders(<DistributionRepo projectId={ID} fullName={FULL} />);
    await userEvent.click(await screen.findByRole("button", { name: "Request access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("GitHub did not answer. Try again.");
    expect(screen.getByRole("button", { name: "Request access" })).toBeInTheDocument();
  });

  it("shows the link alone on a platform without the App", async () => {
    mockFetch({});
    renderWithProviders(<DistributionRepo projectId={ID} fullName={FULL} />);
    expect(screen.getByRole("link", { name: "lab-squashed" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByTestId("distribution-link-first")).toBeNull();
  });
});
