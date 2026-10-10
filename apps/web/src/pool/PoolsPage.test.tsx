import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Me, PoolSummary } from "@quiz/contracts";

import { makeQueryClient, mockFetch, ok, renderWithProviders } from "../test/render";
import { PoolsPage } from "./PoolsPage";

/*
 * The pools page: one primary action ("New pool") and two readings of the
 * same shelf. What a pool offers beyond opening it is its Settings tab's
 * (`PoolSettings.test.tsx`).
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
  coach: { enabled: false, seen: [] },
  rpnCalculator: null,
};

const makePool = (over: Partial<PoolSummary> = {}): PoolSummary => ({
  id: "p1",
  name: "Programmation C",
  icon: "code",
  color: null,
  visibility: "private",
  isPublic: false,
  description: "",
  descriptionSource: "owner",
  ownerId: "u-me",
  isPersonal: false,
  createdAt: "2026-01-01T08:00:00.000Z",
  updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  questionCount: 14,
  usedCount: 9,
  role: "owner",
  heldRole: "owner",
  ownerName: "Prof Démo",
  ownerGivenName: "Prof",
  ownerFamilyName: "Démo",
  ownerAvatarUrl: null,
  memberCount: 0,
  subscriberCount: 0,
  subscription: "none",
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
          description: "Diodes et transistors.\nPremière ligne\nDeuxième\nTroisième\nQuatrième",
          memberCount: 2,
          subscriberCount: 0,
          subscription: "none",
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
    // Whose it is (beside the name) and what I may do in it, only on the pool that is not mine.
    expect(screen.getAllByText("Ada Lovelace")).toHaveLength(1);
    expect(screen.queryByText("Prof Démo")).toBeNull();
    expect(screen.getByText("Contributor")).toBeVisible();
    // The description is clamped to three lines, and only drawn when there is one.
    expect(screen.getByText(/Diodes et transistors/)).toHaveClass("line-clamp-3");
    expect(screen.getAllByText(/hours ago/).length).toBeGreaterThan(0);
  });

  it("opens the pool that was clicked", async () => {
    mockFetch({ [`GET ${POOLS}`]: ok([makePool()]) });
    const navigate = vi.fn();
    renderWithProviders(<PoolsPage navigate={navigate} />, { queryClient: withMe() });
    await userEvent.click(await screen.findByRole("button", { name: /Programmation C/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "pool", id: "p1" });
  });

  it("offers no menu: a card is one door, the rest is the pool's Settings tab", async () => {
    mockFetch({
      [`GET ${POOLS}`]: ok([
        makePool(),
        makePool({ id: "p2", name: "Électronique", role: "contributor", ownerId: "t1" }),
      ]),
    });
    renderWithProviders(<PoolsPage navigate={vi.fn()} />, { queryClient: withMe() });
    await screen.findByText("Programmation C");
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "List" }));
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
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
    // Grey, the default colour, travels as null (#213).
    expect(post?.body).toEqual({ name: "Chimie", icon: "flask-conical", color: null });
  });

  it("draws a pool's colour on its card and keeps grey as it always was (#213)", async () => {
    mockFetch({
      [`GET ${POOLS}`]: ok([
        makePool({ color: null }),
        makePool({
          id: "p2",
          name: "Électronique",
          color: "violet",
          role: "reader",
          ownerId: "t1",
        }),
      ]),
    });
    renderWithProviders(<PoolsPage navigate={vi.fn()} />, { queryClient: withMe() });
    const grey = await screen.findByRole("button", { name: /Programmation C/ });
    expect(grey.querySelector("svg")?.getAttribute("style")).toBeNull();
    // A reader sees the colour...
    const coloured = screen.getByRole("button", { name: /Électronique/ });
    expect(coloured.querySelector("svg")).toHaveStyle({ color: "var(--pool-violet)" });
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

  it("shows every owner as an avatar, my role always, and how many questions were used", async () => {
    mockFetch({
      [`GET ${POOLS}`]: ok([
        makePool(),
        makePool({
          id: "p2",
          name: "Électronique",
          usedCount: 0,
          role: "contributor",
          heldRole: "contributor",
          ownerId: "t1",
          ownerName: "Ada Lovelace",
          ownerGivenName: "Ada",
          ownerFamilyName: "Lovelace",
        }),
      ]),
    });
    renderWithProviders(<PoolsPage navigate={vi.fn()} />, { queryClient: withMe() });
    await screen.findByText("Programmation C");
    await userEvent.click(screen.getByRole("radio", { name: "List" }));

    expect(screen.getByRole("columnheader", { name: "Used" })).toBeInTheDocument();
    // My own pool: my own disc, in the accent, and the role written out —
    // no dash left in either column.
    const mine = screen.getByRole("row", { name: /Programmation C/ });
    const myDisc = within(mine).getByRole("img", { name: "Prof Démo" });
    expect(myDisc).toHaveTextContent("PD");
    expect(myDisc).toHaveClass("bg-accent");
    expect(within(mine).getByText("Owner")).toBeVisible();
    expect(within(mine).getByText("9")).toBeVisible();
    expect(within(mine).queryByText("—")).toBeNull();

    const theirs = screen.getByRole("row", { name: /Électronique/ });
    const theirDisc = within(theirs).getByRole("img", { name: "Ada Lovelace" });
    expect(theirDisc).toHaveTextContent("AL");
    expect(theirDisc).not.toHaveClass("bg-accent");
    expect(within(theirs).getByText("Contributor")).toBeVisible();
    expect(within(theirs).getByText("0")).toBeVisible();
  });

  it("shows an admin with Super Powers the role they hold, not the one lent", async () => {
    // ADR-013 amendment: Super Powers make an owner of every pool for what
    // can be DONE, never for what the list says.
    mockFetch({
      [`GET ${POOLS}`]: ok([
        makePool({ role: "owner", heldRole: "reader", ownerId: "t1", ownerName: "Ada Lovelace" }),
      ]),
    });
    const queryClient = makeQueryClient();
    queryClient.setQueryData(["me"], { ...ME, role: "admin" });
    renderWithProviders(<PoolsPage navigate={vi.fn()} />, { queryClient });
    await screen.findByText("Programmation C");
    await userEvent.click(screen.getByRole("radio", { name: "List" }));

    const row = screen.getByRole("row", { name: /Programmation C/ });
    expect(within(row).getByText("Reader")).toBeVisible();
    expect(within(row).queryByText("Owner")).toBeNull();
  });

  it("sorts the table reading by the column label that was clicked", async () => {
    mockFetch({
      [`GET ${POOLS}`]: ok([
        makePool({ name: "Zoologie", questionCount: 3 }),
        makePool({ id: "p2", name: "Algèbre", questionCount: 40 }),
      ]),
    });
    renderWithProviders(<PoolsPage navigate={vi.fn()} />, { queryClient: withMe() });
    await screen.findByText("Zoologie");
    await userEvent.click(screen.getByRole("radio", { name: "List" }));

    // The shelf arrives in the server's order and stays there until a click.
    const first = () => screen.getAllByRole("row")[1]!.textContent ?? "";
    expect(first()).toContain("Zoologie");

    await userEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(first()).toContain("Algèbre");
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );

    // A count sorts as a number, not as the word it is written with.
    await userEvent.click(screen.getByRole("button", { name: "Questions" }));
    expect(first()).toContain("Zoologie");
  });

  it("offers the one action from the empty state", async () => {
    mockFetch({ [`GET ${POOLS}`]: ok([]) });
    renderWithProviders(<PoolsPage navigate={vi.fn()} />, { queryClient: withMe() });
    expect(await screen.findByText("No pool yet")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /New pool/ })).toHaveLength(1);
  });

  // ADR-054: what an admin sees is the server's call — their own shelf, or
  // every pool while their Super Powers run. The page asks one list.
  it("asks one list, and offers an admin no switch of its own", async () => {
    const { calls } = mockFetch({ [`GET ${POOLS}`]: ok([makePool()]) });
    const queryClient = makeQueryClient();
    queryClient.setQueryData(["me"], { ...ME, role: "admin" });
    renderWithProviders(<PoolsPage navigate={vi.fn()} />, { queryClient });
    expect(await screen.findByText("Programmation C")).toBeVisible();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(calls.every((c) => !c.url.includes("scope="))).toBe(true);
  });
});
