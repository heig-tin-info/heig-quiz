import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Notification, NotificationList } from "@quiz/contracts";

import { notificationsKey } from "../queryKeys";
import { makeQueryClient, renderWithProviders } from "../test/render";
import { TOAST_THROTTLE_MS, ToastGate, useNotificationToasts } from "./toasts";

/*
 * ADR-030, addendum §a and §h: the App channel is the bell AND the toast.
 * The toast is read off the inbox: a baseline after each (re)connect, one
 * toast per new (id, createdAt), none on a quiet page, and at most one per
 * folded entry every five minutes.
 */

const CLASSROOM = "44444444-4444-4444-8444-444444444444";

function joined(id: string, createdAt: string, count = 1, readAt: string | null = null): Notification {
  return {
    id,
    payload: { kind: "student_joined", classroomId: CLASSROOM, classroomName: "PRG1-2026", count },
    createdAt,
    readAt,
  };
}

const T0 = Date.parse("2026-09-28T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

describe("ToastGate", () => {
  it("takes the first read as the baseline, then toasts each new pair once", () => {
    const gate = new ToastGate();
    expect(gate.read([joined("a", at(0))], T0, false)).toEqual([]);
    expect(gate.read([joined("a", at(0))], T0, false)).toEqual([]);
    const b = joined("b", at(1000));
    expect(gate.read([b, joined("a", at(0))], T0 + 1000, false)).toEqual([b]);
    expect(gate.read([b, joined("a", at(0))], T0 + 2000, false)).toEqual([]);
  });

  it("toasts nothing already read, and nothing on a quiet page — for good", () => {
    const gate = new ToastGate();
    gate.read([], T0, false);
    expect(gate.read([joined("r", at(0), 1, at(0))], T0, false)).toEqual([]);
    expect(gate.read([joined("q", at(0))], T0, true)).toEqual([]);
    // Seen while quiet: leaving the page does not toast it late.
    expect(gate.read([joined("q", at(0))], T0, false)).toEqual([]);
  });

  it("rebases on a reconnect: the unread inbox is never replayed", () => {
    const gate = new ToastGate();
    gate.read([], T0, false);
    gate.rebase();
    expect(gate.read([joined("x", at(0)), joined("y", at(1))], T0, false)).toEqual([]);
  });

  it("toasts a folded entry again when it is bumped, at most once per five minutes", () => {
    const gate = new ToastGate();
    gate.read([], T0, false);
    expect(gate.read([joined("f", at(0), 1)], T0, false)).toHaveLength(1);
    // Bumped a minute later: same id, a new createdAt — within the window.
    expect(gate.read([joined("f", at(60_000), 2)], T0 + 60_000, false)).toEqual([]);
    // Bumped after the window: toasts again, with the count it now carries.
    const later = joined("f", at(TOAST_THROTTLE_MS + 1), 3);
    expect(gate.read([later], T0 + TOAST_THROTTLE_MS + 1, false)).toEqual([later]);
  });
});

describe("useNotificationToasts", () => {
  afterEach(() => vi.restoreAllMocks());

  function Probe({ quiet, onRebase }: { quiet: boolean; onRebase?: (rebase: () => void) => void }) {
    onRebase?.(useNotificationToasts(quiet));
    return null;
  }

  function setup(quiet: boolean) {
    const queryClient = makeQueryClient();
    let rebase = () => {};
    const view = renderWithProviders(<Probe quiet={quiet} onRebase={(r) => (rebase = r)} />, {
      queryClient,
    });
    const read = (items: Notification[]) =>
      act(() => {
        queryClient.setQueryData<NotificationList>(notificationsKey, {
          items,
          unread: items.filter((n) => n.readAt === null).length,
        });
      });
    const quietNow = (q: boolean) => view.rerender(<Probe quiet={q} onRebase={(r) => (rebase = r)} />);
    return { read, quietNow, rebase: () => rebase() };
  }

  it("toasts a notification arriving, with the bell's sentence", async () => {
    const { read } = setup(false);
    read([]);
    read([joined("n1", at(0), 3)]);
    expect(await screen.findByText("3 students joined PRG1-2026.")).toBeInTheDocument();
  });

  it("toasts nothing on a quiet page, nor what arrived there once it is left", () => {
    const { read, quietNow } = setup(true);
    read([]);
    read([joined("n1", at(0))]);
    // Bumped while still quiet, then the page is left: the bell's next read
    // is the baseline, not a late toast.
    read([joined("n1", at(1000), 2)]);
    quietNow(false);
    read([joined("n1", at(2000), 3)]);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("toasts nothing on the first read after a reconnect", () => {
    const { read, rebase } = setup(false);
    read([]);
    rebase();
    read([joined("n1", at(0))]);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("toasts a folded entry once per five minutes, however often it is bumped", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(T0);
    const { read } = setup(false);
    read([]);
    read([joined("f", at(0), 1)]);
    expect(await screen.findByText("A student joined PRG1-2026.")).toBeInTheDocument();
    now.mockReturnValue(T0 + 60_000);
    read([joined("f", at(60_000), 2)]);
    expect(screen.queryByText("2 students joined PRG1-2026.")).toBeNull();
    now.mockReturnValue(T0 + TOAST_THROTTLE_MS + 1);
    read([joined("f", at(TOAST_THROTTLE_MS + 1), 3)]);
    expect(await screen.findByText("3 students joined PRG1-2026.")).toBeInTheDocument();
  });
});
