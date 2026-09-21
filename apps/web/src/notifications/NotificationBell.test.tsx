import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Notification } from "@quiz/contracts";

import { mockFetch, ok, renderWithProviders } from "../test/render";
import { NotificationBell, NOTIFICATION_LIMIT } from "./NotificationBell";

/*
 * The bell: a count, a list of sentences, and a click that takes the reader
 * to the pool the sentence is about and marks it read on the way.
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

describe("NotificationBell", () => {
  it("counts the unread ones and writes each kind as a sentence", async () => {
    mockFetch({ [`GET ${LIST}`]: ok({ items: [SHARED, INHERITED], unread: 1 }) });
    renderWithProviders(<NotificationBell navigate={vi.fn()} />);

    const bell = await screen.findByRole("button", { name: "Notifications (1 unread)" });
    // The count rides on the bell itself, beside it in the DOM.
    expect(screen.getByText("1")).toBeVisible();

    await userEvent.click(bell);
    const panel = screen.getByRole("dialog", { name: "Notifications" });
    expect(
      within(panel).getByText(
        /Ada Lovelace shared the pool “Électronique analogique” with you as contributor\./,
      ),
    ).toBeVisible();
    expect(
      within(panel).getByText(/You are now the owner of “Systèmes embarqués” \(from Grace Hopper\)\./),
    ).toBeVisible();
  });

  it("caps the badge at 9+", async () => {
    mockFetch({ [`GET ${LIST}`]: ok({ items: [SHARED], unread: 23 }) });
    renderWithProviders(<NotificationBell navigate={vi.fn()} />);
    await screen.findByRole("button", { name: "Notifications (23 unread)" });
    expect(screen.getByText("9+")).toBeVisible();
  });

  it("opens the pool of the one that was picked, and marks it read", async () => {
    const { calls } = mockFetch({
      [`GET ${LIST}`]: ok({ items: [SHARED], unread: 1 }),
      "POST /app/api/notifications/n1/read": { status: 204 },
    });
    const navigate = vi.fn();
    renderWithProviders(<NotificationBell navigate={navigate} />);

    await userEvent.click(await screen.findByRole("button", { name: /Notifications/ }));
    await userEvent.click(screen.getByText(/Ada Lovelace shared the pool/));

    expect(navigate).toHaveBeenCalledWith({ view: "pool", id: "p3" });
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/n1/read"))).toBe(true);
    // The panel is gone: the reader is on the pool now.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks the whole inbox read from the panel", async () => {
    const { calls } = mockFetch({
      [`GET ${LIST}`]: ok({ items: [SHARED], unread: 1 }),
      "POST /app/api/notifications/read-all": { status: 204 },
    });
    renderWithProviders(<NotificationBell navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /Notifications/ }));
    await userEvent.click(screen.getByRole("button", { name: /Mark all as read/ }));
    expect(calls.some((c) => c.url.endsWith("/notifications/read-all"))).toBe(true);
  });

  it("says so when there is nothing, and offers no count", async () => {
    mockFetch({ [`GET ${LIST}`]: ok({ items: [], unread: 0 }) });
    renderWithProviders(<NotificationBell navigate={vi.fn()} />);
    const bell = await screen.findByRole("button", { name: "Notifications" });
    await userEvent.click(bell);
    expect(screen.getByText("Nothing new")).toBeVisible();
  });

  it("closes on Escape and hands the focus back to the bell", async () => {
    mockFetch({ [`GET ${LIST}`]: ok({ items: [SHARED], unread: 1 }) });
    renderWithProviders(<NotificationBell navigate={vi.fn()} />);
    const bell = await screen.findByRole("button", { name: /Notifications/ });
    await userEvent.click(bell);
    expect(screen.getByRole("dialog")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bell).toHaveFocus();
  });
});
