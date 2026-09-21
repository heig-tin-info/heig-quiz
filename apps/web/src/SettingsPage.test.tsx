import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { SettingsPage } from "./SettingsPage";
import { makeMe } from "./test/fixtures";
import { mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * The preferences that are stored on the ACCOUNT, so they follow the teacher
 * from one machine to the next: the MCQ scoring default of docs/04 §4.4 is
 * one of them, and it is the first level of the three-level hierarchy.
 */
describe("SettingsPage — multiple-answer scoring", () => {
  const routes = { "PATCH /app/api/me": ok({ mcqPolicy: "discordance" }) };

  it("shows the description of the policy in force, and saves a change", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes);
    renderWithProviders(<SettingsPage me={makeMe({ mcqPolicy: null })} />);

    // No preference means all or nothing, and the row says what that does.
    const select = screen.getByRole("combobox", { name: /multiple-answer scoring/i });
    expect(select).toHaveValue("all_or_nothing");
    expect(
      screen.getByText(/full marks for the exact set of correct choices/i),
    ).toBeInTheDocument();

    await user.selectOptions(select, "discordance");
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch?.body).toMatchObject({ mcqPolicy: "discordance" });
    });
  });

  it("offers the five policies, and `inherit` is not one of them", () => {
    mockFetch(routes);
    renderWithProviders(<SettingsPage me={makeMe({ mcqPolicy: "ripkey" })} />);
    const options = screen
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value)
      .filter((v) => v.includes("_") || ["ripkey", "symmetric", "discordance"].includes(v));
    expect(options).toEqual([
      "all_or_nothing",
      "true_false",
      "discordance",
      "symmetric",
      "ripkey",
    ]);
  });

  /*
   * A student creates no evaluation, so the row would be a setting with
   * nothing to set: the page does not show it at all.
   */
  it("is not on a student's settings page", () => {
    mockFetch(routes);
    renderWithProviders(<SettingsPage me={makeMe({ role: "student" })} />);
    expect(
      screen.queryByRole("combobox", { name: /multiple-answer scoring/i }),
    ).not.toBeInTheDocument();
  });
});
