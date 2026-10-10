import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Me, PoolDetail, PoolMembers } from "@quiz/contracts";

import { fail, makeQueryClient, mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { PoolSettings } from "./PoolSettings";

/*
 * The pool's Settings tab: an owner renames it, gives it its look, shares it
 * and deletes it; anyone else is told so, and a member may leave. What the
 * pools list's card menu used to hold.
 */

const POOL = "/app/api/pools/p1";
const MEMBERS = `${POOL}/members`;

const ME = { id: "u-me", email: "teacher@heig-vd.ch", role: "teacher" } as Me;

const makeDetail = (over: Partial<PoolDetail["pool"]> = {}, role: PoolDetail["role"] = "owner"): PoolDetail => ({
  pool: {
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
    updatedAt: "2026-09-18T08:00:00.000Z",
    ...over,
  },
  role,
  categories: [],
  concepts: [],
  questionCount: 14,
  subscription: "none",
  subscribers: null,
});

const members: PoolMembers = { visibility: "private", members: [], courses: [] };

function renderSettings(detail: PoolDetail, navigate = vi.fn()) {
  const queryClient = makeQueryClient();
  queryClient.setQueryData(["me"], ME);
  renderWithProviders(<PoolSettings detail={detail} navigate={navigate} />, { queryClient });
  return navigate;
}

describe("PoolSettings", () => {
  it("offers an owner the name, the icon, the sharing and the deletion", async () => {
    mockFetch({ [`GET ${MEMBERS}`]: ok(members) });
    renderSettings(makeDetail());

    expect(screen.getByRole("button", { name: "Rename" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Change the icon" })).toBeVisible();
    expect(screen.getByRole("switch", { name: "Publish in the catalogue" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Description" })).toBeVisible();
    expect(await screen.findByText("Nobody else has access yet.")).toBeVisible();
    expect(screen.getByRole("button", { name: /Delete pool/ })).toBeVisible();
    // The account the pool belongs to cannot leave it.
    expect(screen.queryByRole("button", { name: /Leave/ })).toBeNull();
  });

  it("lists the subscribers by name to a seat holder, with no way to remove one", async () => {
    mockFetch({
      "GET /app/api/pools/p1/subscribers": ok({ subscribers: [{ name: "Ada Lovelace" }, { name: "Grace Hopper" }] }),
    });
    renderSettings({ ...makeDetail({ ownerId: "t1", isPublic: true }, "contributor"), subscribers: 2 });
    expect(await screen.findByText("Subscribers (2)")).toBeVisible();
    expect(await screen.findByText("Grace Hopper")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("does not draw the subscribers for a reader of a public pool, who can unsubscribe", async () => {
    const { calls } = mockFetch({ "DELETE /app/api/pools/p1/subscription": noContent() });
    renderSettings({ ...makeDetail({ ownerId: "t1", isPublic: true }, "reader"), subscription: "subscribed" });
    expect(screen.queryByText(/^Subscribers/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Unsubscribe" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/subscription"))).toBe(true));
  });

  it("tells a member what is the owners', and offers them the way out", async () => {
    const { calls } = mockFetch({ "DELETE /app/api/pools/p1/members/u-me": noContent() });
    const navigate = renderSettings(makeDetail({ ownerId: "t1" }, "contributor"));

    expect(screen.getByText(/are its owners' to change/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete pool/ })).toBeNull();
    // No sharing section, so no members call either.
    expect(calls.some((c) => c.url === MEMBERS)).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: /^Leave$/ }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "pools" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("deletes the pool after a confirmation, then goes back to the shelf", async () => {
    mockFetch({ [`GET ${MEMBERS}`]: ok(members), [`DELETE ${POOL}`]: noContent() });
    const navigate = renderSettings(makeDetail());

    await userEvent.click(screen.getByRole("button", { name: /Delete pool/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Delete “Programmation C”\?/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "pools" }));
  });

  it("names what still holds a pool it may not delete, and stays", async () => {
    mockFetch({
      [`GET ${MEMBERS}`]: ok(members),
      [`DELETE ${POOL}`]: fail(409, {
        error: "pool_in_use",
        uses: [{ id: "00000000-0000-4000-8000-000000000001", title: "Exam 1", template: false }],
        hidden: 0,
      }),
    });
    const navigate = renderSettings(makeDetail());

    await userEvent.click(screen.getByRole("button", { name: /Delete pool/ }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/Exam 1 still use its questions/)).toBeVisible();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("colours the icon from the same dialog and saves it with the icon (#213)", async () => {
    const { calls } = mockFetch({
      [`GET ${MEMBERS}`]: ok(members),
      [`PATCH ${POOL}`]: ok(makeDetail({ color: "cyan" }).pool),
    });
    renderSettings(makeDetail());

    await userEvent.click(screen.getByRole("button", { name: "Change the icon" }));

    // Sixteen swatches, each named, grey (the default) chosen.
    const swatches = within(screen.getByRole("group", { name: "Colour" })).getAllByRole("radio");
    expect(swatches).toHaveLength(16);
    expect(screen.getByRole("radio", { name: "Grey (default)" })).toBeChecked();

    // A click, then the arrow keys walk the row.
    await userEvent.click(screen.getByRole("radio", { name: "Teal" }));
    expect(screen.getByRole("radio", { name: "Teal" })).toBeChecked();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Cyan" })).toBeChecked();

    // Every tile previews its icon in the colour being chosen.
    const tile = screen.getByRole("button", { name: "code" });
    expect(tile).toHaveAttribute("aria-pressed", "true");
    expect(tile.querySelector("svg")).toHaveStyle({ color: "var(--pool-cyan)" });

    // Picking the icon takes both back to the form; Save sends both.
    await userEvent.click(tile);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ name: "Programmation C", icon: "code", color: "cyan" });
  });

  it("saves a colour alone, without picking the icon again (#213)", async () => {
    const { calls } = mockFetch({
      [`GET ${MEMBERS}`]: ok(members),
      [`PATCH ${POOL}`]: ok(makeDetail({ color: "pink" }).pool),
    });
    renderSettings(makeDetail());

    await userEvent.click(screen.getByRole("button", { name: "Change the icon" }));
    await userEvent.click(screen.getByRole("radio", { name: "Pink" }));
    // Leaving the picker keeps the colour: the form holds it, ready to save.
    await userEvent.keyboard("{Escape}");
    const form = await screen.findByRole("dialog");
    const trigger = within(form).getByRole("button", { name: "Change the icon" });
    expect(trigger.querySelector("svg")).toHaveStyle({ color: "var(--pool-pink)" });
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ name: "Programmation C", icon: "code", color: "pink" });
  });

  it("saves the owner's own description", async () => {
    const { calls } = mockFetch({
      [`GET ${MEMBERS}`]: ok(members),
      [`PATCH ${POOL}`]: ok(makeDetail({ description: "Du C." }).pool),
    });
    renderSettings(makeDetail());
    const field = screen.getByRole("textbox", { name: "Description" });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.type(field, "Du C.");
    expect(screen.getByText(/5 \/ 280 characters/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ description: "Du C." }));
  });

  it("writes the AI's proposal only when the owner accepts it", async () => {
    const { calls } = mockFetch({
      [`GET ${MEMBERS}`]: ok(members),
      [`POST ${POOL}/description/propose`]: ok({ description: "Pointeurs et mémoire." }),
      [`PATCH ${POOL}`]: ok(makeDetail({ description: "Pointeurs et mémoire.", descriptionSource: "ai" }).pool),
    });
    renderSettings(makeDetail());
    await userEvent.click(screen.getByRole("button", { name: /Suggest a description/ }));
    expect(await screen.findByText("Pointeurs et mémoire.")).toBeVisible();
    // Nothing is written by the proposal alone.
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Use this description" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        description: "Pointeurs et mémoire.",
        descriptionFromAi: true,
      }),
    );
  });

  it("does not offer the AI over a description the owner wrote", async () => {
    mockFetch({ [`GET ${MEMBERS}`]: ok(members) });
    renderSettings(makeDetail({ description: "Écrit à la main." }));
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("Écrit à la main.");
    expect(screen.queryByRole("button", { name: /Suggest a description/ })).toBeNull();
  });
});
