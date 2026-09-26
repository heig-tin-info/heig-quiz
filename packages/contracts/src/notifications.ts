/**
 * Notification catalogue shared by the API (emitters) and the web app
 * (toasts). One definition: adding a kind on one side without the other is
 * a compile error.
 */

/** Real-time toast kinds carried by SSE notices (events.ts AppNotice). */
export type NoticeKind = "student_joined" | "roster_conflict";

import { z } from "zod";

/**
 * Persistent, per-account notifications (the bell): stored by the API,
 * listed and marked read over HTTP, refreshed through a `notifications`
 * hint on the user's own topic. Unlike a toast, one survives a reload.
 */
/** What each kind carries; the web app renders the sentence from it. */
export const NotificationPayload = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pool_shared"),
    poolId: z.uuid(),
    poolName: z.string(),
    role: z.enum(["reader", "contributor", "owner"]),
    /** Who shared it, as displayed. */
    byName: z.string(),
  }),
  z.object({
    kind: z.literal("pool_ownership"),
    poolId: z.uuid(),
    poolName: z.string(),
    /** The account that owned it before, as displayed. */
    fromName: z.string(),
  }),
  z.object({
    /**
     * The results of an evaluation the recipient took were released
     * (F-GRADE-09). Ids and the title only: the grade itself is read on the
     * feedback page, behind the student's own session, never carried here —
     * a notification also leaves the platform by e-mail and Teams.
     */
    kind: z.literal("results_released"),
    evaluationId: z.uuid(),
    evaluationTitle: z.string(),
    /** The attempt that counts, whose feedback page the notification opens. */
    attemptId: z.uuid(),
  }),
]);
export type NotificationPayload = z.infer<typeof NotificationPayload>;

export const Notification = z.object({
  id: z.uuid(),
  payload: NotificationPayload,
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export type Notification = z.infer<typeof Notification>;

/** `GET /notifications`: newest first, capped; `unread` counts the whole inbox. */
export const NotificationList = z.object({
  items: z.array(Notification),
  unread: z.number().int(),
});
export type NotificationList = z.infer<typeof NotificationList>;

/** Its query: how many rows the bell wants. `unread` is never capped. */
export const NotificationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type NotificationQuery = z.infer<typeof NotificationQuery>;

// --- Delivery channels and preferences (ADR-030) ---------------------------

/** Every kind of persistent notification, in the order the settings list them. */
export const NOTIFICATION_KINDS = ["results_released", "pool_shared", "pool_ownership"] as const;
export const NotificationKind = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKind>;

/**
 * Where one notification may go: the bell (the inbox of the app), an e-mail
 * to the account's address, a Microsoft Teams chat message once the account
 * has linked Teams.
 */
export const NOTIFICATION_CHANNELS = ["bell", "email", "teams"] as const;
export const NotificationChannel = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof NotificationChannel>;

/**
 * What a user who never touched a toggle gets: everything on. Teams only
 * applies once the account is linked, so "on" there costs nothing until then.
 */
export const DEFAULT_CHANNEL_ENABLED: Record<NotificationChannel, boolean> = {
  bell: true,
  email: true,
  teams: true,
};

/** The kinds a role receives, as the settings grid lists them. */
export function notificationKindsFor(role: "student" | "teacher" | "admin"): NotificationKind[] {
  return role === "student" ? ["results_released"] : [...NOTIFICATION_KINDS];
}

/** The resolved grid: every kind × every channel, defaults filled in. */
export const NotificationMatrix = z.record(
  NotificationKind,
  z.record(NotificationChannel, z.boolean()),
);
export type NotificationMatrix = z.infer<typeof NotificationMatrix>;

/** The Teams link as the settings card shows it. */
export const TeamsLinkStatus = z.object({
  /** The platform has a Teams application configured (`TEAMS_*` env). */
  available: z.boolean(),
  /** When this account linked Teams; null when it did not. */
  linkedAt: z.string().nullable(),
});
export type TeamsLinkStatus = z.infer<typeof TeamsLinkStatus>;

/** `GET /app/api/notifications/settings`. */
export const NotificationSettings = z.object({
  matrix: NotificationMatrix,
  /** The address e-mails go to: the account's own, nothing to configure. */
  email: z.string(),
  teams: TeamsLinkStatus,
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;

/** `PUT /app/api/notifications/preferences`: one toggle of the grid. */
export const NotificationPreferencePut = z.object({
  kind: NotificationKind,
  channel: NotificationChannel,
  enabled: z.boolean(),
});
export type NotificationPreferencePut = z.infer<typeof NotificationPreferencePut>;

/** `POST /app/api/notifications/teams/connect`: where the browser goes next. */
export const TeamsConnectStart = z.object({ url: z.string() });
export type TeamsConnectStart = z.infer<typeof TeamsConnectStart>;

/** The query Microsoft sends back to the Teams callback. */
export const TeamsCallbackQuery = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(256).optional(),
  error_description: z.string().max(2048).optional(),
});
export type TeamsCallbackQuery = z.infer<typeof TeamsCallbackQuery>;

/**
 * The catalogue of kinds and the payload union are one list: a kind added to
 * the union and not to {@link NOTIFICATION_KINDS} (or the reverse) makes this
 * type `false`, and the assignment below a compile error.
 */
export type KindsMatchPayloads = [NotificationPayload["kind"]] extends [NotificationKind]
  ? [NotificationKind] extends [NotificationPayload["kind"]]
    ? true
    : false
  : false;
export const KINDS_MATCH_PAYLOADS: KindsMatchPayloads = true;
