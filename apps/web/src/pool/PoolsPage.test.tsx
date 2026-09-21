import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Me, PoolSummary } from "@quiz/contracts";

import { makeQueryClient, mockFetch, ok, renderWithProviders } from "../test/render";
import { PoolsPage } from "./PoolsPage";

/*
 * The pools page: one primary action ("New pool"), two readings of the same
 * shelf, and a menu whose items depend on what the caller may actually do —
 * an owner renames and deletes, a member leaves.
 */

const POOLS = "/app/api/pools";

const ME: Me = {
  id: "u-me",
  email: "teacher@heig-vd.ch",
  givenName: "Prof",
  familyName: "Démo",
  role: "teacher",
  lastLoginAt: null,
  avatarUrl: null,
  hasUploadedAvatar: false,
  locale: null,
  dateFormat: null,
  mcqPolicy: null,
};

const makePool = (over: Partial<PoolSummary> = {}): PoolSummary => ({
  id: "p1",
  name: "Programmation C",
  icon: "code",
  visibility: "private",
  ownerId: "u-me",
  isPersonal: false,
  createdAt: "2026-01-01T08:00:00.000Z",
  updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  questionCount: 14,
  role: "owner",
  ownerName: "Prof Démo",
  memberCount: 0,
  ...over,
});

/** The `me` query the page reads, seeded instead of stubbed. */
function withMe() {
  const queryClient = makeQueryClient();
  queryClient.setQueryData(["me"], ME);
  return queryClient;
}

describe("PoolsPage", () => {
  it("shows what a pool is: its count, its visibility and when it moved", async () => {
    mockFetch({
      [`GET ${POOLS}`]: ok([
        makePool(),
        makePool({
          id: "p2",
          name: "Électronique",
          questionCount: 7,
          visibility: "shared",
          memberCount: 2,
          role: "contributor",
          ownerId: "t1",
          ownerName: "Ada Lovelace",
        }),
      ]),
    });
    renderWithProviders(<PoolsPage navigate={vi.fn()} />, { queryClient: withMe() });

    expect(await screen.findByText("Programmation C")).toBeVisible();
    expect(screen.getByText("14 questions")).toBeVisible();
    expect(screen.getByText("private")).toBeVisible();
    expect(screen.getByText("shared with 2")).toBeVisible();
    // Whose it is and what I may do in it, only on the pool that is not mine.
    expect(screen.getByText("Ada Lovelace · Contributor")).toBeVisible();
    expect(screen.getAllByText(/hours ago/).length).toBeGreaterThan(0);
  });

  it("opens the pool that was clicked", async () => {
    mockFetch({ [`GET ${POOLS}`]: ok([makePool()]) });
    const navigate = vi.fn();
    renderWithProviders(<PoolsPage navigate={navigate} />, { queryClient: withMe() });
    await userEvent.click(await screen.findByRole("button", { name: /Programmation C/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "pool", id: "p1" });
  });

  it("offers the owner's actions to an owner and the member's to a member", async () => {
    mockFetch({
      [`GET ${POOLS}`]: ok([
        makePool(),
        makePool({ id: "p2", name: "Électronique", role: "contributor", ownerId: "t1" }),
      ]),
    });
    renderWithProviders(<PoolsPage navigate={vi.fn()} />, { queryClient: withMe() });
    await screen.findByText("Programmation C");

    const menus = screen.getAllByRole("button", { name: "Actions" });
    await userEvent.click(menus[0]!);
    const mine = screen.getByRole("menu");
    expect(within(mine).getByRole("menuitem", { name: /Rename pool/ })).toBeVisible();
    expect(within(mine).getByRole("menuitem", { name: /Share/ })).toBeVisible();
    expect(within(mine).getByRole("menuitem", { name: /Delete pool/ })).toBeVisible();
    expect(within(mine).queryByRole("menuitem", { name: /Leave/ })).toBeNull();
    await userEvent.keyboard("{Escape}");

    await userEvent.click(menus[1]!);
    const theirs = screen.getByRole("menu");
    expect(within(theirs).getByRole("menuitem", { name: /Leave pool/ })).toBeVisible();
    expect(within(theirs).queryByRole("menuitem", { name: /Delete pool/ })).toBeNull();
    expect(within(theirs).queryByRole("menuitem", { name: /Share/ })).toBeNull();
  });

  it("creates a pool with the icon that was picked", async () => {
    const { calls } = mockFetch({
      [`GET ${POOLS}`]: ok([makePool()]),
      [`POST ${POOLS}`]: ok(makePool({ id: "p9", name: "Chimie", icon: "flask-conical" })),
    });
    renderWithProviders(<PoolsPage navigate={vi.fn()} />, { queryClient: withMe() });

    await userEvent.click(await screen.findByRole("button", { name: /New pool/ }));
    await userEvent.type(screen.getByLabelText("Name"), "Chimie");
    // The picker is the same dialog, one step in; picking comes back to the form.
    await userEvent.click(screen.getByRole("button", { name: "Change the icon" }));
    await userEvent.click(await screen.findByRole("button", { name: "flask-conical" }));
    await userEvent.click(screen.getByRole("button", { name: "Create pool" }));

    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ name: "Chimie", icon: "flask-conical" });
  });

  it("switches to the table reading and keeps the same facts", async () => {
    mockFetch({ [`GET ${POOLS}`]: ok([makePool({ memberCount: 1, visibility: "shared" })]) });
    renderWithProviders(<PoolsPage navigate={vi.fn()} />, { queryClient: withMe() });
    await screen.findByText("Programmation C");

    await userEvent.click(screen.getByRole("radio", { name: "List" }));
    const row = screen.getByRole("row", { name: /Programmation C/ });
    expect(within(row).getByText("14")).toBeVisible();
    expect(within(row).getByText("shared with 1")).toBeVisible();
  });

  it("offers the one action from the empty state", async () => {
    mockFetch({ [`GET ${POOLS}`]: ok([]) });
    renderWithProviders(<PoolsPage navigate={vi.fn()} />, { queryClient: withMe() });
    expect(await screen.findByText("No pool yet")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /New pool/ })).toHaveLength(1);
  });
});
