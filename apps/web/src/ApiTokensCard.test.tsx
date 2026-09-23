import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { ApiToken } from "@quiz/contracts";

import { ApiTokensCard } from "./ApiTokensCard";
import { mockFetch, ok, renderWithProviders } from "./test/render";

const token = (over: Partial<ApiToken> = {}): ApiToken => ({
  id: "0190d3c4-0000-7000-8000-000000000001",
  name: "Claude Desktop",
  prefix: "quiz_pat_Xk3v9Q",
  createdAt: "2026-09-01T08:00:00.000Z",
  lastUsedAt: null,
  expiresAt: "2099-01-01T00:00:00.000Z",
  revokedAt: null,
  ...over,
});

/*
 * ADR-022: the secret is shown once, in the creation dialog, with the lines
 * that connect an MCP client; the list only ever carries a prefix.
 */
describe("ApiTokensCard", () => {
  it("lists the tokens by name and prefix, with their state", async () => {
    mockFetch({
      "GET /app/api/me/tokens": ok([token(), token({ id: "0190d3c4-0000-7000-8000-000000000002", name: "Old", revokedAt: "2026-09-02T08:00:00.000Z" })]),
    });
    renderWithProviders(<ApiTokensCard />);
    expect(await screen.findByText("Claude Desktop")).toBeInTheDocument();
    expect(screen.getAllByText("quiz_pat_Xk3v9Q…")).toHaveLength(2);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Revoked")).toBeInTheDocument();
  });

  it("creates a token and reveals it once, with the MCP address", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /app/api/me/tokens": ok([]),
      "POST /app/api/me/tokens": ok({ ...token(), token: "quiz_pat_SECRETSECRET" }),
    });
    renderWithProviders(<ApiTokensCard />);
    await user.click(await screen.findByRole("button", { name: /new token/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: /name/i }), "Claude");
    await user.click(within(dialog).getByRole("button", { name: /create token/i }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Claude", expiresInDays: 90 }),
    );
    const reveal = await screen.findByRole("dialog", { name: /token created/i });
    expect(within(reveal).getByRole("textbox", { name: /^token$/i })).toHaveValue("quiz_pat_SECRETSECRET");
    expect(within(reveal).getByRole("textbox", { name: /mcp server address/i })).toHaveValue(
      `${window.location.origin}/app/api/mcp`,
    );
  });
});
