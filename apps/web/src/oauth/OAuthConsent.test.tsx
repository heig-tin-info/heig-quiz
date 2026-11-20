import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MCP_CONSENT_REVISION } from "@quiz/contracts";

import { makeMe } from "../test/fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { OAuthConsent } from "./OAuthConsent";

const ID = "0190d3c4-0000-7000-8000-0000000000aa";

/*
 * ADR-023, ADR-139 §14: the consent screen says what an assistant may do,
 * students' contestations included, and an approval names the consent this
 * page showed — the bundle's revision.
 */
describe("OAuthConsent", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says the assistant reads contestations masked and only prepares answers, and sends the revision it showed", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, search: "" });
    const { calls } = mockFetch({
      [`GET /app/api/oauth/requests/${ID}`]: ok({
        id: ID,
        clientName: "Claude",
        clientUri: null,
        redirectHost: "claude.ai",
        loopback: false,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
      [`POST /app/api/oauth/requests/${ID}/decision`]: ok({ redirectTo: "https://claude.ai/back" }),
    });
    renderWithProviders(<OAuthConsent id={ID} me={makeMe({ role: "teacher" })} />);
    expect(
      await screen.findByText(
        "Read contested questions and criteria with the students' answers and reasons, names and addresses masked. A student may still be recognisable.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Prepare answers to contestations for the course's Teacher role to confirm")).toBeVisible();
    expect(screen.getByText("Send an answer to a contestation")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ approve: true, consentRevision: MCP_CONSENT_REVISION }),
    );
  });
});
