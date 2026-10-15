import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { ApiToken } from "@quiz/contracts";

import { ApiTokensCard } from "./ApiTokensCard";
import { makeMe } from "./test/fixtures";
import { mockFetch, ok, renderWithProviders } from "./test/render";

const token = (over: Partial<ApiToken> = {}): ApiToken => ({
  id: "0190d3c4-0000-7000-8000-000000000001",
  name: "Claude Desktop",
  prefix: "quiz_pat_Xk3v9Q",
  createdAt: "2026-09-01T08:00:00.000Z",
  lastUsedAt: null,
  expiresAt: "2099-01-01T00:00:00.000Z",
  revokedAt: null,
  scope: "quiz",
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

  it("shows each token's access, a token issued before the scopes as Full API (ADR-113)", async () => {
    mockFetch({
      "GET /app/api/me/tokens": ok([
        token(),
        token({ id: "0190d3c4-0000-7000-8000-000000000002", name: "Reader", scope: "quiz:read" }),
        token({ id: "0190d3c4-0000-7000-8000-000000000003", name: "Script", scope: "api" }),
      ]),
    });
    renderWithProviders(<ApiTokensCard />);
    expect(await screen.findByText("AI assistant (MCP), read and write")).toBeInTheDocument();
    expect(screen.getByText("AI assistant (MCP), read only")).toBeInTheDocument();
    expect(screen.getByText("Full API")).toBeInTheDocument();
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
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Claude", scope: "quiz", expiresInDays: 90 }),
    );
    const reveal = await screen.findByRole("dialog", { name: /token created/i });
    expect(within(reveal).getByRole("textbox", { name: /^token$/i })).toHaveValue("quiz_pat_SECRETSECRET");
    expect(within(reveal).getByRole("textbox", { name: /mcp server address/i })).toHaveValue(
      `${window.location.origin}/app/api/mcp`,
    );
  });

  it("creates a full API token: it must expire, and the reveal shows a command line, not the MCP address", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /app/api/me/tokens": ok([]),
      "POST /app/api/me/tokens": ok({ ...token({ scope: "api" }), token: "quiz_pat_SECRETSECRET" }),
    });
    renderWithProviders(<ApiTokensCard />);
    await user.click(await screen.findByRole("button", { name: /new token/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /read and write/i })).toBeChecked();
    const select = within(dialog).getByRole("combobox", { name: /expires/i });
    await user.selectOptions(select, "never");
    await user.type(within(dialog).getByRole("textbox", { name: /name/i }), "Script");
    await user.click(within(dialog).getByRole("radio", { name: /full api/i }));
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).not.toContain("Never");
    expect(select).toHaveValue("90");
    expect(within(dialog).getByText(/full api token always expires/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /create token/i }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Script", scope: "api", expiresInDays: 90 }),
    );
    const reveal = await screen.findByRole("dialog", { name: /token created/i });
    expect(within(reveal).getByRole("textbox", { name: /command line/i })).toHaveValue(
      `curl -H "Authorization: Bearer quiz_pat_SECRETSECRET" ${window.location.origin}/app/api/courses`,
    );
    expect(within(reveal).queryByRole("textbox", { name: /mcp server address/i })).toBeNull();
  });

  it("offers a teacher a token that never expires, never an administrator (audit L6)", async () => {
    const user = userEvent.setup();
    const lifetimes = async (role: "teacher" | "admin") => {
      mockFetch({ "GET /app/api/me": ok(makeMe({ role })), "GET /app/api/me/tokens": ok([]) });
      const view = renderWithProviders(<ApiTokensCard />);
      await user.click(await screen.findByRole("button", { name: /new token/i }));
      const dialog = await screen.findByRole("dialog");
      const select = within(dialog).getByRole("combobox", { name: /expires/i });
      await waitFor(() => expect(within(dialog).queryByText(/always expires/i) !== null).toBe(role === "admin"));
      const options = within(select).getAllByRole("option").map((o) => o.textContent);
      view.unmount();
      return options;
    };
    expect(await lifetimes("teacher")).toContain("Never");
    expect(await lifetimes("admin")).not.toContain("Never");
  });
});
