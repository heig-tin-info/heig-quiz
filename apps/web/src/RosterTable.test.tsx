import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RosterTable } from "./RosterTable";
import { makeRosterEntry } from "./test/fixtures";
import { mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * The roster rows. Revoking a claim and removing a student are the two
 * destructive actions of this table: they go through the confirm dialog, and
 * while one is in flight the row says so and refuses to fire it a second
 * time. `mockFetch` answers at once, which is the one thing a pending state
 * cannot be tested against, so this file stubs a fetch that never answers.
 */

const UNCLAIM = "/app/api/classrooms/c1/roster/e-1/unclaim";

/** Records every call and never answers: the mutation stays pending. */
function hangingFetch() {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Promise<Response>(() => {});
    }),
  );
  return urls;
}

const openRowMenu = async () => {
  await userEvent.click(screen.getByRole("button", { name: "Actions for Lucas Rochat" }));
  return screen.getByRole("menu");
};

describe("RosterTable pending actions", () => {
  it("shows the row is busy and refuses a second revoke while the first runs", async () => {
    const urls = hangingFetch();
    renderWithProviders(<RosterTable classroomId="c1" roster={[makeRosterEntry()]} />, {
      route: "/classrooms/c1?tab=students",
    });

    await userEvent.click(
      within(await openRowMenu()).getByRole("menuitem", { name: "Revoke claim" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke claim" }));

    // The menu closed on the click, so the row itself has to carry the fact
    // that something is running.
    await waitFor(() => expect(screen.getByLabelText("Loading…")).toBeVisible());
    expect(urls.filter((u) => u === UNCLAIM)).toHaveLength(1);

    const item = within(await openRowMenu()).getByRole("menuitem", { name: "Revoke claim" });
    expect(item).toBeDisabled();
    await userEvent.click(item).catch(() => {
      // user-event refuses a disabled control; that is exactly the point.
    });
    expect(urls.filter((u) => u === UNCLAIM)).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables Remove from roster the same way", async () => {
    const urls = hangingFetch();
    renderWithProviders(<RosterTable classroomId="c1" roster={[makeRosterEntry()]} />, {
      route: "/classrooms/c1?tab=students",
    });

    await userEvent.click(
      within(await openRowMenu()).getByRole("menuitem", { name: "Remove from roster" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove from roster" }));
    await waitFor(() => expect(screen.getByLabelText("Loading…")).toBeVisible());

    expect(
      within(await openRowMenu()).getByRole("menuitem", { name: "Remove from roster" }),
    ).toBeDisabled();
    expect(urls).toHaveLength(1);
  });
});

describe("RosterTable impersonation link (ADR-034)", () => {
  it("is offered to an admin only, on a claimed student seat, and shown to copy", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { calls } = mockFetch({
      "POST /app/api/classrooms/c1/roster/e-1/impersonation": ok({ url: "https://quiz.test/app/auth/as/s3cr3t" }),
    });
    const { unmount } = renderWithProviders(<RosterTable classroomId="c1" roster={[makeRosterEntry()]} />);
    expect(within(await openRowMenu()).queryByRole("menuitem", { name: "Copy link as this student" })).toBeNull();
    unmount();

    renderWithProviders(<RosterTable classroomId="c1" roster={[makeRosterEntry()]} canImpersonate />);
    await userEvent.click(
      within(await openRowMenu()).getByRole("menuitem", { name: "Copy link as this student" }),
    );
    // In a dialog, copied by a click of its own: Safari refuses a clipboard
    // write that follows the request's await.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("textbox", { name: "One-time link" })).toHaveValue(
      "https://quiz.test/app/auth/as/s3cr3t",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: /^Copy/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://quiz.test/app/auth/as/s3cr3t"));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});

describe("RosterTable GitHub login", () => {
  it("shows a linked student's login under the address, and nothing for the others", () => {
    renderWithProviders(
      <RosterTable
        classroomId="c1"
        roster={[makeRosterEntry({ githubLogin: "lrochat" }), makeRosterEntry({ id: "e-2", nom: "Favre", githubLogin: null })]}
      />,
      { route: "/classrooms/c1?tab=students" },
    );
    expect(screen.getByText("lrochat")).toBeVisible();
    expect(screen.getAllByText("GitHub account")).toHaveLength(1);
  });
});
