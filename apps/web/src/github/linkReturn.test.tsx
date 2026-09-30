import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { useGithubLinkReturn } from "./linkReturn";

/*
 * The return of a GitHub link round trip (F-GH-05): `?github=` toasted once,
 * then taken out of the address, the rest of it kept.
 */

function Return({ enabled = true }: { enabled?: boolean }) {
  useGithubLinkReturn(enabled);
  return null;
}

describe("the return of a GitHub link", () => {
  it.each([
    ["linked", "GitHub account linked."],
    ["conflict", "This GitHub account is already linked to another Quiz account."],
    ["error", "Linking GitHub failed. Try again."],
  ])("toasts ?github=%s, then drops the parameter and keeps the rest", async (outcome, text) => {
    renderWithProviders(<Return />, { route: `/classrooms/r1/settings?tab=x&github=${outcome}#top` });
    expect(await screen.findByText(text)).toBeVisible();
    expect(window.location.pathname).toBe("/classrooms/r1/settings");
    expect(window.location.search).toBe("?tab=x");
    expect(window.location.hash).toBe("#top");
  });

  it("drops an unknown value without a word, and waits for the session", async () => {
    renderWithProviders(<Return />, { route: "/settings?github=%3Cb%3Ehi" });
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(screen.queryByText(/GitHub/)).toBeNull();

    renderWithProviders(<Return enabled={false} />, { route: "/settings?github=linked" });
    expect(window.location.search).toBe("?github=linked");
  });
});
