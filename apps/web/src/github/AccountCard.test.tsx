import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GithubAccountState } from "@quiz/contracts";

import { mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { GithubAccountCard } from "./AccountCard";

/*
 * The user Settings' GitHub card (F-GH-05): shown only when relevant, Link to
 * the App's authorisation back to this page, or the linked login and Unlink.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const ME_GITHUB = "/app/api/me/github";
const LINKED: GithubAccountState = {
  account: { login: "ychevallier", linkedAt: "2026-08-01T00:00:00.000Z" },
  relevant: true,
};

describe("the user Settings' GitHub card", () => {
  it("offers Link GitHub when relevant, back to the page it is on", async () => {
    mockFetch({ [`GET ${ME_GITHUB}`]: ok({ account: null, relevant: true }) });
    renderWithProviders(<GithubAccountCard />, { route: "/settings" });
    expect(await screen.findByRole("link", { name: "Link GitHub" })).toHaveAttribute(
      "href",
      "/app/auth/github/link?return=%2Fsettings",
    );
  });

  it("is not there when not relevant and nothing is linked, nor without an App", async () => {
    const { calls } = mockFetch({ [`GET ${ME_GITHUB}`]: ok({ account: null, relevant: false }) });
    renderWithProviders(<GithubAccountCard />);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(screen.queryByRole("heading", { name: "GitHub" })).toBeNull();

    mockFetch({});
    renderWithProviders(<GithubAccountCard />);
    await waitFor(() => expect(screen.queryByText("GitHub account")).toBeNull());
  });

  it("shows a linked account even when no longer relevant, and unlinks it", async () => {
    let state: GithubAccountState = { ...LINKED, relevant: false };
    const { calls } = mockFetch({
      [`GET ${ME_GITHUB}`]: () => ok(state),
      [`DELETE ${ME_GITHUB}`]: () => {
        state = { account: null, relevant: true };
        return noContent();
      },
    });
    renderWithProviders(<GithubAccountCard />);
    expect(await screen.findByText(/Linked to ychevallier/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await screen.findByText("GitHub account unlinked.")).toBeVisible();
    expect(await screen.findByRole("link", { name: "Link GitHub" })).toBeVisible();
  });
});
