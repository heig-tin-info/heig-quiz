import { hashKey, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import type { Notification, NotificationList } from "@quiz/contracts";

import { useT } from "../i18n";
import { useNotify } from "../notify";
import { notificationsKey } from "../queryKeys";
import { notificationSentence } from "./NotificationPanel";

/** A folded entry keeps its id: it toasts at most once in this window. */
export const TOAST_THROTTLE_MS = 5 * 60_000;

/** A notification as it last arrived: a fold refreshes `createdAt`, not the id. */
const arrival = (n: Notification) => `${n.id}@${n.createdAt}`;

/**
 * Which notifications of an inbox read become toasts (ADR-030, addendum §a
 * and §h). The toast is the live rendering of a notification arriving; the
 * stream carries no data, so "arriving" is read off the inbox itself:
 *
 * - the first read after a (re)connect — or after a quiet page — is the
 *   BASELINE and toasts nothing, so a reload never replays the unread inbox;
 * - after that, each new unread `(id, createdAt)` pair toasts once;
 * - nothing toasts while the page is quiet (an attempt, a projection, the
 *   live dashboard); the bell still counts it;
 * - one entry toasts at most once per {@link TOAST_THROTTLE_MS}: a folded
 *   entry a whole class bumps in a minute is one toast, not thirty.
 *
 * Pure and per tab: several tabs each toast, a duplicate that is accepted
 * rather than coordinated.
 */
export class ToastGate {
  private readonly seen = new Set<string>();
  private readonly toastedAt = new Map<string, number>();
  private baseline = true;

  /** The next read sets the baseline. */
  rebase(): void {
    this.baseline = true;
  }

  /** The entries of this read to toast, newest first as the inbox lists them. */
  read(items: readonly Notification[], now: number, quiet: boolean): Notification[] {
    const fresh = items.filter((n) => n.readAt === null && !this.seen.has(arrival(n)));
    for (const n of items) this.seen.add(arrival(n));
    if (this.baseline) {
      this.baseline = false;
      return [];
    }
    if (quiet) return [];
    return fresh.filter((n) => {
      const last = this.toastedAt.get(n.id);
      if (last !== undefined && now - last < TOAST_THROTTLE_MS) return false;
      this.toastedAt.set(n.id, now);
      return true;
    });
  }
}

/**
 * Toasts the notifications that arrive while this tab is open: every
 * successful read of the inbox query goes through the {@link ToastGate}.
 * The read itself is the bell's (`NotificationPanel`), refetched on the
 * `notifications` hint; nothing is fetched here.
 *
 * `quiet` is the page's: leaving a quiet page rebases, so what arrived
 * while it was on screen is counted by the bell and never toasted late.
 * The returned `rebase` is for the stream's (re)connection.
 */
export function useNotificationToasts(quiet: boolean): () => void {
  const qc = useQueryClient();
  const notify = useNotify();
  const t = useT();
  const [gate] = useState(() => new ToastGate());
  const quietNow = useRef(quiet);

  useEffect(() => {
    if (quietNow.current && !quiet) gate.rebase();
    quietNow.current = quiet;
  }, [gate, quiet]);

  useEffect(
    () =>
      qc.getQueryCache().subscribe((event) => {
        if (event.type !== "updated" || event.action.type !== "success") return;
        if (event.query.queryHash !== hashKey(notificationsKey)) return;
        const list = event.query.state.data as NotificationList | undefined;
        if (!list) return;
        for (const n of gate.read(list.items, Date.now(), quietNow.current)) {
          notify(notificationSentence(n.payload, t));
        }
      }),
    [qc, gate, notify, t],
  );

  return () => gate.rebase();
}
