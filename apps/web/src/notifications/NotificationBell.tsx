import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, CheckCheck } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { Notification, NotificationList, NotificationPayload } from "@quiz/contracts";

import { api } from "../api";
import { useT, type TFunction } from "../i18n";
import type { Route } from "../router";
import {
  Button,
  cx,
  EmptyState,
  IconButton,
  menuPosition,
  pressable,
  QueryError,
  RelativeTime,
  Skeleton,
  useLayer,
  Z,
  type MenuPlacement,
} from "../ui";
import { notificationsKey } from "../queryKeys";

/**
 * The bell: what happened to this account while it was away (F-POOL-05 for
 * now — a pool shared, a pool inherited). Unlike a toast, a notification
 * survives a reload, so the list is a query and not a state.
 *
 * It refreshes by itself: the API sends a `notifications` hint on the user's
 * own SSE topic and `useLiveUpdates` invalidates every active query on any
 * hint, so this one refetches with the rest. Nothing here listens to the
 * stream.
 *
 * The panel is a floating layer built from the same two pieces as `Menu` —
 * `menuPosition` for the coordinates and `useLayer` for Escape, the outside
 * click and the focus coming back to the bell — because the rows are
 * sentences with a date and a read mark in them, which a `MenuItem` (a label
 * and a muted second line) cannot carry. It is a `dialog` and not a `menu`:
 * arrows scroll a list of sentences here, they do not walk a set of commands.
 */

/** How many the bell asks for; the server caps the list, `unread` counts all. */
export const NOTIFICATION_LIMIT = 30;
const LIST_URL = `/app/api/notifications?limit=${NOTIFICATION_LIMIT}`;

/** Over this, the badge stops counting and says so. */
const BADGE_CAP = 9;

/** Panel geometry: 22 rem of sentences, the page's own 16 px side gutter. */
const PANEL_WIDTH = 352;
const GUTTER = 16;
/** What the panel is assumed to be worth when deciding to open it upward. */
const PANEL_MAX_HEIGHT = 420;

/**
 * One notification as a sentence. Pure and exported: the payloads are a
 * closed union, and this is the one place that turns a kind into words, in
 * either language.
 */
function notificationSentence(payload: NotificationPayload, t: TFunction): string {
  switch (payload.kind) {
    case "pool_shared":
      return t("notif.poolShared", {
        byName: payload.byName,
        poolName: payload.poolName,
        role: t(`share.role.${payload.role}`).toLowerCase(),
      });
    case "pool_ownership":
      return t("notif.poolOwnership", {
        poolName: payload.poolName,
        fromName: payload.fromName,
      });
  }
}

/** Where a notification takes the reader: today, always the pool it is about. */
function notificationRoute(payload: NotificationPayload): Route {
  return { view: "pool", id: payload.poolId };
}

function NotificationRow({
  item,
  onOpen,
}: {
  item: Notification;
  onOpen: (item: Notification) => void;
}) {
  const t = useT();
  const unread = item.readAt === null;
  return (
    // A div and not a <button>: `RelativeTime` is focusable (it carries the
    // full date in a Tip on hover AND on focus), and a focusable node inside a
    // button is invalid content. `pressable` gives the row the keyboard
    // contract of a button without the nesting.
    <div
      {...pressable(() => onOpen(item))}
      onClick={() => onOpen(item)}
      className="flex w-full cursor-pointer items-start gap-2.5 rounded-[10px] px-2.5 py-2 text-left transition-colors hover:bg-surface-2"
    >
      {/* The unread mark is a dot and a weight, not a tinted row: the accent
          on this panel belongs to the count on the bell, and a column of
          red-tinted rows would win the squint test against it. */}
      <span
        className={cx("mt-1.5 size-1.5 shrink-0 rounded-full", unread ? "bg-accent" : "bg-transparent")}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className={cx("block text-[13px] leading-snug", unread ? "font-semibold text-fg" : "text-fg-muted")}>
          {unread ? <span className="sr-only">{t("notif.unread")} </span> : null}
          {notificationSentence(item.payload, t)}
        </span>
        <RelativeTime iso={item.createdAt} className="mt-0.5 block text-xs text-fg-faint" />
      </span>
    </div>
  );
}

export function NotificationBell({
  navigate,
  align = "start",
}: {
  navigate: (r: Route) => void;
  /** Which edge of the bell the panel hangs from (`end` in the phone top bar). */
  align?: "start" | "end";
}) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPlacement | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const list = useQuery<NotificationList>({
    queryKey: notificationsKey,
    queryFn: () => api(LIST_URL),
  });

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) anchor.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  useLayer(panel, () => close(true), { trap: false, enabled: open });

  // Outside click, like `Menu`: a click on the bell itself is the toggle
  // below, and one inside the panel is the reader using it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchor.current?.contains(target) || panel.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  /**
   * Both write routes answer with the WHOLE inbox as it now stands, so the
   * panel updates from the reply instead of asking for the list a second
   * time. A reply without a body (a 204) still refetches, so the two are
   * never out of step.
   */
  const adopt = (list: NotificationList | undefined) => {
    if (list) qc.setQueryData(notificationsKey, list);
    else void qc.invalidateQueries({ queryKey: notificationsKey });
  };
  const markRead = useMutation({
    mutationFn: (id: string) =>
      api<NotificationList | undefined>(`/app/api/notifications/${id}/read`, { method: "POST" }),
    onSuccess: adopt,
  });
  const markAll = useMutation({
    mutationFn: () =>
      api<NotificationList | undefined>("/app/api/notifications/read-all", { method: "POST" }),
    onSuccess: adopt,
  });

  const unread = list.data?.unread ?? 0;
  const items = list.data?.items ?? [];

  const toggle = () => {
    if (open) {
      close(false);
      return;
    }
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const placed = menuPosition(rect, viewport, align, PANEL_MAX_HEIGHT);
    // `menuPosition` anchors the panel on the trigger and stops there. This
    // panel is 352 px wide and the phone's bell sits 20 px from the right
    // edge, so the anchored panel hung 18 px off the left of the screen:
    // clamp it to the 16 px gutter, in the direction it hangs from.
    const width = Math.min(PANEL_WIDTH, viewport.width - 2 * GUTTER);
    setPos({
      ...placed,
      left:
        align === "end"
          ? Math.max(placed.left, width + GUTTER)
          : Math.min(placed.left, viewport.width - width - GUTTER),
    });
    setOpen(true);
  };

  const openItem = (item: Notification) => {
    if (item.readAt === null) markRead.mutate(item.id);
    close(false);
    navigate(notificationRoute(item.payload));
  };

  return (
    <>
      <span ref={anchor} className="relative inline-flex">
        <IconButton
          label={unread > 0 ? t("notif.titleUnread", { n: unread }) : t("notif.title")}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={toggle}
        >
          <Bell />
        </IconButton>
        {unread > 0 ? (
          // A count on an icon, so it carries the accent fill rather than a
          // soft badge: it is the one thing on this row that is new.
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold leading-none text-on-fill tabular-nums"
          >
            {unread > BADGE_CAP ? `${BADGE_CAP}+` : unread}
          </span>
        ) : null}
      </span>

      {open && pos
        ? createPortal(
            <div
              ref={panel}
              role="dialog"
              aria-labelledby={titleId}
              tabIndex={-1}
              className={cx(
                "menu-panel fixed flex w-88 max-w-[calc(100vw-2rem)] flex-col rounded-menu border border-line bg-surface shadow-popover focus:outline-none",
                Z.popover,
              )}
              style={
                {
                  top: pos.top,
                  bottom: pos.bottom,
                  left: pos.left,
                  "--menu-x": align === "end" ? "-100%" : "0",
                  transformOrigin: `${pos.up ? "bottom" : "top"} ${align === "end" ? "right" : "left"}`,
                } as React.CSSProperties
              }
            >
              <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                <h2 id={titleId} className="min-w-0 flex-1 text-[13px] font-semibold">
                  {t("notif.title")}
                </h2>
                {unread > 0 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={markAll.isPending}
                    onClick={() => markAll.mutate()}
                  >
                    <CheckCheck /> {t("notif.markAll")}
                  </Button>
                ) : null}
              </div>
              <div className="max-h-[60dvh] min-h-0 overflow-y-auto p-1">
                {list.isLoading ? (
                  <div className="space-y-2 p-2">
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-2/3" />
                  </div>
                ) : list.isError ? (
                  <div className="p-2">
                    <QueryError
                      title={t("notif.title")}
                      error={list.error}
                      onRetry={() => void list.refetch()}
                      retrying={list.isFetching}
                    />
                  </div>
                ) : items.length === 0 ? (
                  <EmptyState className="py-8" icon={BellOff} title={t("notif.empty.title")}>
                    {t("notif.empty.body")}
                  </EmptyState>
                ) : (
                  items.map((item) => (
                    <NotificationRow key={item.id} item={item} onOpen={openItem} />
                  ))
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
