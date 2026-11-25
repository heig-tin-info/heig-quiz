import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { AdminScheduledTask } from "@quiz/contracts";

import { TasksSection } from "./AdminTasks";
import { mockFetch, ok, renderWithProviders } from "./test/render";

const purge: AdminScheduledTask = {
  key: "presence.purge",
  enabled: true,
  intervalMinutes: 1440,
  defaultIntervalMinutes: 1440,
  lastRunAt: null,
  lastStatus: null,
  lastMessage: null,
  lastDurationMs: null,
  lastOkAt: null,
  nextRunAt: null,
};

/*
 * DESIGN.md › Row cards: a task's "Run now" keeps its words on the row and
 * is an item of the card's "…" (`RowActions worded`, one source for both).
 * It runs the task from either.
 */
describe("TasksSection — Run now", () => {
  const routes = {
    "GET /app/api/admin/tasks": ok([purge]),
    "POST /app/api/admin/tasks/presence.purge/run": ok({ ...purge, lastStatus: "ok" }),
  };
  const posted = (calls: { method: string }[]) => calls.filter((c) => c.method === "POST").length;

  it("is a worded button on the row", async () => {
    const { calls } = mockFetch(routes);
    renderWithProviders(<TasksSection />);
    const group = await screen.findByRole("group", { name: "Actions for Activity hours purge" });
    await userEvent.click(within(group).getByRole("button", { name: "Run Activity hours purge now" }));
    await waitFor(() => expect(posted(calls)).toBe(1));
  });

  it("is an item of the card's menu", async () => {
    const { calls } = mockFetch(routes);
    renderWithProviders(<TasksSection />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Actions for Activity hours purge" }));
    await u.click(await screen.findByRole("menuitem", { name: "Run now" }));
    await waitFor(() => expect(posted(calls)).toBe(1));
  });
});
