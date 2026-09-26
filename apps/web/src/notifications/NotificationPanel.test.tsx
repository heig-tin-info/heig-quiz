import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Notification } from "@quiz/contracts";

import { UserMenu } from "../Header";
import { makeMe } from "../test/fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { NOTIFICATION_LIMIT } from "./NotificationPanel";

/*
 * The inbox, in the account menu: a count on the avatar, an item that opens
 * a list of sentences, and a click that takes the reader to the pool the
 * sentence is about and marks it read on the way.
 */

const LIST = `/app/api/notifications?limit=${NOTIFICATION_LIMIT}`;

const SHARED: Notification = {
  id: "n1",
  payload: {
    kind: "pool_shared",
    poolId: "p3",
    poolName: "Électronique analogique",
    role: "contributor",
    byName: "Ada Lovelace",
  },
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  readAt: null,
};

const INHERITED: Notification = {
  id: "n2",
  payload: {
    kind: "pool_ownership",
    poolId: "p2",
    poolName: "Systèmes embarqués",
    fromName: "Grace Hopper",
  },
  createdAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
  readAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
};

const renderMenu = (navigate = vi.fn()) =>
  renderWithProviders(
    <UserMenu me={makeMe()} onOpenSettings={vi.fn()} notifications={{ navigate }} />,
  );

/** Opens the account menu, then its "Notifications" item; returns the trigger. */
const openInbox = async (triggerName: string | RegExp = /User menu/) => {
  const trigger = await screen.findByRole("button", { name: triggerName });
  await userEvent.click(trigger);
  await userEvent.click(
    within(screen.getByRole("menu")).getByRole("menuitem", { name: /Notifications/ }),
  );
  return trigger;
};

describe("the inbox in the account menu", () => {
  it("counts the unread ones and writes each kind as a sentence", async () => {
    mockFetch({ [`GET ${LIST}`]: ok({ items: [SHARED, INHERITED], unread: 1 }) });
    renderMenu();

    await openInbox("User menu (1 unread notifications)");
    const panel = screen.getByRole("dialog", { name: "Notifications" });
    expect(
      within(panel).getByText(
        /Ada Lovelace shared the pool “Électronique analogique” with you as contributor\./,
      ),
    ).toBeVisible();
    expect(
      within(panel).getByText(
        /You are now the owner of “Systèmes embarqués” \(from Grace Hopper\)\./,
      ),
    ).toBeVisible();
  });

  it("puts the count on the avatar, capped at 9+, and on the menu item", async () => {
    mockFetch({ [`GET ${LIST}`]: ok({ items: [SHARED], unread: 23 }) });
    renderMenu();
    const trigger = await screen.findByRole("button", {
      name: "User menu (23 unread notifications)",
    });
    expect(within(trigger).getByText("9+")).toBeVisible();
    await userEvent.click(trigger);
    expect(within(screen.getByRole("menu")).getByText("23 unread")).toBeVisible();
  });

  it("opens the pool of the one that was picked, and marks it read", async () => {
    const { calls } = mockFetch({
      [`GET ${LIST}`]: ok({ items: [SHARED], unread: 1 }),
      "POST /app/api/notifications/n1/read": { status: 204 },
    });
    const navigate = vi.fn();
    renderMenu(navigate);

    await openInbox();
    await userEvent.click(screen.getByText(/Ada Lovelace shared the pool/));

    expect(navigate).toHaveBeenCalledWith({ view: "pool", id: "p3" });
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/n1/read"))).toBe(true);
    // The panel is gone: the reader is on the pool now.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("announces released results and opens the feedback of that attempt", async () => {
    const RELEASED: Notification = {
      id: "n3",
      payload: {
        kind: "results_released",
        evaluationId: "e1",
        evaluationTitle: "Test 0 — bases du C",
        attemptId: "a7",
      },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      readAt: null,
    };
    mockFetch({
      [`GET ${LIST}`]: ok({ items: [RELEASED], unread: 1 }),
      "POST /app/api/notifications/n3/read": { status: 204 },
    });
    const navigate = vi.fn();
    renderMenu(navigate);
    await openInbox();
    await userEvent.click(
      screen.getByText(/The results of “Test 0 — bases du C” are available\./),
    );
    expect(navigate).toHaveBeenCalledWith({ view: "feedback", attemptId: "a7" });
  });

  it("marks the whole inbox read from the panel", async () => {
    const { calls } = mockFetch({
      [`GET ${LIST}`]: ok({ items: [SHARED], unread: 1 }),
      "POST /app/api/notifications/read-all": { status: 204 },
    });
    renderMenu();
    await openInbox();
    await userEvent.click(screen.getByRole("button", { name: /Mark all as read/ }));
    expect(calls.some((c) => c.url.endsWith("/notifications/read-all"))).toBe(true);
  });

  it("says so when there is nothing, and offers no count", async () => {
    mockFetch({ [`GET ${LIST}`]: ok({ items: [], unread: 0 }) });
    renderMenu();
    await openInbox("User menu");
    expect(screen.getByText("Nothing new")).toBeVisible();
  });

  it("closes on Escape and hands the focus back to the account menu", async () => {
    mockFetch({ [`GET ${LIST}`]: ok({ items: [SHARED], unread: 1 }) });
    renderMenu();
    const trigger = await openInbox();
    expect(screen.getByRole("dialog")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("is not there without an inbox (a student), and asks for nothing", async () => {
    const { calls } = mockFetch({});
    renderWithProviders(<UserMenu me={makeMe()} onOpenSettings={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "User menu" }));
    expect(
      within(screen.getByRole("menu")).queryByRole("menuitem", { name: /Notifications/ }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
