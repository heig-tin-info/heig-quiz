import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { Me } from "@quiz/contracts";

import { SettingsPage } from "./SettingsPage";
import { SuperPowersBanner } from "./SuperPowers";
import { makeMe } from "./test/fixtures";
import { mockFetch, ok, renderWithProviders } from "./test/render";

/** An admin whose session has Super Powers until `ms` from now; null: off. */
const admin = (ms: number | null): Me =>
  makeMe({
    role: "admin",
    session: {
      kind: "portal",
      evaluationId: null,
      readOnly: false,
      superPowersUntil: ms === null ? null : new Date(Date.now() + ms).toISOString(),
      superPowersAvailable: true,
    },
  });

describe("Super Powers in the settings (ADR-054)", () => {
  it("are an admin's: a teacher's settings say nothing of them", () => {
    mockFetch({});
    renderWithProviders(<SettingsPage me={makeMe({ role: "teacher" })} />);
    expect(screen.queryByRole("button", { name: "Switch on for one hour" })).toBeNull();
  });

  it("switch on from the settings, through the server", async () => {
    const { calls } = mockFetch({
      "POST /app/api/me/super-powers": ok({
        superPowersUntil: new Date().toISOString(),
      }),
    });
    renderWithProviders(<SettingsPage me={admin(null)} />);
    await userEvent.click(screen.getByRole("button", { name: "Switch on for one hour" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
  });
});

describe("the Super Powers banner", () => {
  it("is not there while they are off", () => {
    renderWithProviders(<SuperPowersBanner me={admin(null)}>page</SuperPowersBanner>);
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByText("page")).toBeVisible();
  });

  it("says so above the page, with the minutes left and the way out", async () => {
    const { calls } = mockFetch({
      "DELETE /app/api/me/super-powers": ok({ superPowersUntil: null }),
    });
    renderWithProviders(<SuperPowersBanner me={admin(42 * 60_000)}>page</SuperPowersBanner>);
    const banner = screen.getByRole("region", { name: /Super Powers/ });
    expect(banner).toHaveTextContent("42 min left");
    await userEvent.click(screen.getByRole("button", { name: "Switch off" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("counts down by the second in the last five minutes", () => {
    renderWithProviders(<SuperPowersBanner me={admin(4 * 60_000)}>page</SuperPowersBanner>);
    expect(screen.getByRole("timer")).toHaveTextContent(/Ends in [34]:\d\d/);
  });
});
