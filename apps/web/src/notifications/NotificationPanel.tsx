import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, CheckCheck } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { Notification, NotificationList, NotificationPayload, SystemCheckKey } from "@quiz/contracts";

import { api } from "../api";
import { useT, type Dict, type TFunction } from "../i18n";
import type { Route } from "../router";
import {
  Button,
  cx,
  EmptyState,
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
 * The inbox: what happened to this account while it was away — a pool
 * shared or inherited (F-POOL-05), results released (F-GRADE-09), students
 * who joined a classroom, roster entries to decide, grading to validate,
 * questions published in a shared pool, exercises scheduled and opened, an
 * evaluation closing within 24 hours (#198). It lives in the account menu — an
 * item "Notifications" and a count on the avatar — rather than behind a bell
 * of its own, which sat beside the account row and truncated the e-mail.
 * A notification survives a reload, so the list is a query and not a state;
 * the toast of one arriving is read off the same query (`toasts.ts`).
 *
 * It refreshes by itself: the API sends a `notifications` hint on the user's
 * own SSE topic and `useLiveUpdates` invalidates every active query on any
 * hint, so this one refetches with the rest. Nothing here listens to the
 * stream.
 *
 * The panel is a floating layer built from the same two pieces as `Menu` —
 * `menuPosition` for the coordinates and `useLayer` for Escape, the outside
 * click and the focus coming back to the account menu — because the rows are
 * sentences with a date and a read mark in them, which a `MenuItem` (a label
 * and a muted second line) cannot carry. It is a `dialog` and not a `menu`:
 * arrows scroll a list of sentences here, they do not walk a set of commands.
 */

/** How many the inbox asks for; the server caps the list, `unread` counts all. */
export const NOTIFICATION_LIMIT = 30;
const LIST_URL = `/app/api/notifications?limit=${NOTIFICATION_LIMIT}`;

/** Over this, the badge stops counting and says so. */
const BADGE_CAP = 9;

/** Panel geometry: 22 rem of sentences, the page's own 16 px side gutter. */
const PANEL_WIDTH = 352;
const GUTTER = 16;
/** What the panel is assumed to be worth when deciding to open it upward. */
const PANEL_MAX_HEIGHT = 420;

/** A health check's name, as the System status page gives it. */
const checkName = (key: SystemCheckKey) => `admin.system.check.${key}` as const satisfies keyof Dict;

/**
 * One notification as a sentence. Pure and exported: the payloads are a
 * closed union, and this is the one place that turns a kind into words, in
 * either language.
 */
export function notificationSentence(payload: NotificationPayload, t: TFunction): string {
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
    case "results_released":
      return t("notif.resultsReleased", { evaluationTitle: payload.evaluationTitle });
    case "activity_scheduled":
      return t(payload.count === 1 ? "notif.activityScheduled.one" : "notif.activityScheduled", {
        n: payload.count,
        classroom: payload.classroomName,
      });
    case "activity_available":
      return t("notif.activityAvailable", { evaluationTitle: payload.activityTitle });
    case "deadline_approaching":
      return t("notif.deadlineApproaching", { evaluationTitle: payload.evaluationTitle });
    case "results_updated":
      return t("notif.resultsUpdated", { evaluationTitle: payload.evaluationTitle });
    case "student_joined":
      return t(payload.count === 1 ? "notif.studentJoined.one" : "notif.studentJoined", {
        n: payload.count,
        classroom: payload.classroomName,
      });
    case "roster_conflict":
      return t(payload.count === 1 ? "notif.rosterConflict.one" : "notif.rosterConflict", {
        n: payload.count,
        classroom: payload.classroomName,
      });
    case "grading_ready":
      return t(payload.count === 1 ? "notif.gradingReady.one" : "notif.gradingReady", {
        n: payload.count,
        evaluationTitle: payload.evaluationTitle,
      });
    case "pool_question_added":
      return t(payload.count === 1 ? "notif.poolQuestionAdded.one" : "notif.poolQuestionAdded", {
        n: payload.count,
        poolName: payload.poolName,
      });
    case "system_alert":
      return t(`notif.systemAlert.${payload.state}`, {
        checks: payload.checks.map((key) => t(checkName(key))).join(", "),
      });
    // The project kinds (F-NOTIF-13): the project's name, counts, never a score.
    case "project_published":
      return t("notif.projectPublished", { projectTitle: payload.projectTitle });
    case "project_deadline_reminder":
      return t("notif.projectDeadlineReminder", { projectTitle: payload.projectTitle });
    case "project_repo_invited":
      return t("notif.projectRepoInvited", { projectTitle: payload.projectTitle });
    case "project_grade_final":
      return t("notif.projectGradeFinal", { projectTitle: payload.projectTitle });
    case "project_deadline_applied":
      return t(payload.count === 1 ? "notif.projectDeadlineApplied.one" : "notif.projectDeadlineApplied", {
        n: payload.count,
        projectTitle: payload.projectTitle,
      });
    case "project_provision_failed":
      return t(payload.count === 1 ? "notif.projectProvisionFailed.one" : "notif.projectProvisionFailed", {
        n: payload.count,
        projectTitle: payload.projectTitle,
        reason: t(`notif.provisionReason.${payload.reason}`),
      });
    case "github_org_lost":
      return t("notif.githubOrgLost", { classroom: payload.classroomName, org: payload.orgLogin });
  }
}

/**
 * Where a notification takes the reader: the pool it is about, the
 * feedback page of the attempt whose results were released or updated, the roster
 * of the classroom, the grading panel of the evaluation, the student home
 * (exercises scheduled) or the attempt of an exercise that opened or of an
 * evaluation about to close, the project a project kind is about (the
 * staff's page, or the student's view of it) and the Settings of a
 * classroom whose organization was lost. The e-mail and the Teams message
 * link to the same page (`templates.ts` on the server).
 */
function notificationRoute(payload: NotificationPayload): Route {
  switch (payload.kind) {
    case "pool_shared":
    case "pool_ownership":
    case "pool_question_added":
      return { view: "pool", id: payload.poolId };
    case "results_released":
    case "results_updated":
      return { view: "feedback", attemptId: payload.attemptId };
    case "student_joined":
    case "roster_conflict":
      return { view: "classroom", id: payload.classroomId, tab: "roster" };
    case "grading_ready":
      return { view: "grading", evaluationId: payload.evaluationId };
    case "activity_scheduled":
      return { view: "home" };
    case "deadline_approaching":
      return { view: "attempt", evaluationId: payload.evaluationId };
    case "system_alert":
      return { view: "admin", tab: "system" };
    case "project_published":
    case "project_deadline_reminder":
    case "project_repo_invited":
    case "project_grade_final":
    case "project_deadline_applied":
    case "project_provision_failed":
      return { view: "project", id: payload.projectId };
    case "github_org_lost":
      return { view: "classroomSettings", id: payload.classroomId };
    case "activity_available":
      switch (payload.activityKind) {
        case "evaluation":
          return { view: "attempt", evaluationId: payload.activityId };
        // Never sent for a project, which has kinds of its own (F-NOTIF-13).
        case "project":
          return { view: "home" };
      }
  }
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
      className="flex w-full cursor-pointer items-start gap-2.5 rounded-field px-2.5 py-2 text-left transition-colors hover:bg-surface-2"
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

/** The inbox query, shared by the badge on the avatar and the panel. */
function useInbox(enabled = true) {
  return useQuery<NotificationList>({
    queryKey: notificationsKey,
    queryFn: () => api(LIST_URL),
    enabled,
  });
}

/** How many are unread, for the account menu's badge and label; 0 while loading. */
export function useUnreadNotifications(enabled: boolean): number {
  return useInbox(enabled).data?.unread ?? 0;
}

/**
 * The count on the avatar. A count on an icon, so it carries the accent fill
 * rather than a soft badge: it is the one thing on that row that is new.
 * `aria-hidden`: the trigger's label says it in words.
 */
export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold leading-none text-on-fill tabular-nums ring-2 ring-canvas"
    >
      {count > BADGE_CAP ? `${BADGE_CAP}+` : count}
    </span>
  );
}

/**
 * The panel, opened from the account menu's "Notifications" item and hung
 * from the menu's trigger (`anchor`). Closing it hands the focus back to the
 * first button inside `anchor` — the account menu's trigger.
 */
export function NotificationPanel({
  open,
  onClose,
  anchor,
  navigate,
  align = "start",
}: {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
  navigate: (r: Route) => void;
  /** Which edge of the anchor the panel hangs from (`end` in the phone top bar). */
  align?: "start" | "end";
}) {
  const t = useT();
  const qc = useQueryClient();
  const [pos, setPos] = useState<MenuPlacement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const list = useInbox();

  const close = useCallback(
    (restoreFocus: boolean) => {
      onClose();
      if (restoreFocus) anchor.current?.querySelector<HTMLElement>("button")?.focus();
    },
    [onClose, anchor],
  );
  const shown = open && pos !== null;
  useLayer(panel, () => close(true), { trap: false, enabled: shown });

  // Outside click, like `Menu`: one inside the panel is the reader using it.
  useEffect(() => {
    if (!shown) return;
    const onDown = (e: MouseEvent) => {
      if (panel.current?.contains(e.target as Node)) return;
      close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [shown, close]);

  // Placed from the anchor's rectangle when it opens, before paint.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
    };
    const placed = menuPosition(rect, viewport, align, PANEL_MAX_HEIGHT);
    // `menuPosition` anchors the panel on the trigger and stops there. This
    // panel is 352 px wide and the phone's avatar sits 12 px from the right
    // edge, so the anchored panel would hang off the left of the screen:
    // clamp it to the 16 px gutter, in the direction it hangs from.
    const width = Math.min(PANEL_WIDTH, viewport.width - 2 * GUTTER);
    setPos({
      ...placed,
      left:
        align === "end"
          ? Math.max(placed.left, width + GUTTER)
          : Math.min(placed.left, viewport.width - width - GUTTER),
    });
  }, [open, anchor, align]);

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

  const openItem = (item: Notification) => {
    if (item.readAt === null) markRead.mutate(item.id);
    close(false);
    navigate(notificationRoute(item.payload));
  };

  return (
    <>
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
