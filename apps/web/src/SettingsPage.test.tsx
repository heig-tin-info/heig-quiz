import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

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

describe("SettingsPage — RPN calculator", () => {
  it("is off by default, and saves the switch on the account", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({ "PATCH /app/api/me": ok({}) });
    renderWithProviders(<SettingsPage me={makeMe({ rpnCalculator: null })} />);
    const toggle = screen.getByRole("switch", { name: "RPN calculator" });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await waitFor(() => {
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ rpnCalculator: true });
    });
  });

  it("shows it on when the account has it", () => {
    mockFetch({});
    renderWithProviders(<SettingsPage me={makeMe({ rpnCalculator: true })} />);
    expect(screen.getByRole("switch", { name: "RPN calculator" })).toBeChecked();
  });
});

/*
 * #449: on a phone the bottom bar's Profile slot leads here, and the sidebar
 * that held Administration and the view switch is gone. Both rows sit at the
 * top of the page, under `lg` only (CSS: jsdom draws them at any width).
 */
describe("SettingsPage — the phone's rows", () => {
  it("leads an admin in the teacher UI to the Administration", async () => {
    const user = userEvent.setup();
    mockFetch({});
    const navigate = vi.fn();
    renderWithProviders(<SettingsPage me={makeMe({ role: "admin" })} navigate={navigate} teacherUi />);
    await user.click(screen.getByRole("button", { name: /Administration/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "admin" });
  });

  it("offers no Administration row to a plain teacher, nor to an admin in the student view", () => {
    mockFetch({});
    renderWithProviders(<SettingsPage me={makeMe({ role: "teacher" })} navigate={vi.fn()} teacherUi />);
    expect(screen.queryByRole("button", { name: /Administration/ })).toBeNull();
    cleanup();
    renderWithProviders(<SettingsPage me={makeMe({ role: "admin" })} navigate={vi.fn()} teacherUi={false} />);
    expect(screen.queryByRole("button", { name: /Administration/ })).toBeNull();
  });

  it("carries the student-view switch for whoever has one", async () => {
    const user = userEvent.setup();
    mockFetch({});
    const toggle = vi.fn();
    renderWithProviders(
      <SettingsPage me={makeMe()} navigate={vi.fn()} teacherUi onToggleStudentView={toggle} />,
    );
    await user.click(screen.getByRole("radio", { name: "Student" }));
    expect(toggle).toHaveBeenCalled();
  });

  it("draws neither row for a student", () => {
    mockFetch({});
    renderWithProviders(<SettingsPage me={makeMe({ role: "student" })} navigate={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Administration/ })).toBeNull();
    expect(screen.queryByText("View as")).toBeNull();
  });
});
