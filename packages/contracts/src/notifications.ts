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
  /** The platform has a Teams bot configured (`TEAMS_*` env). */
  available: z.boolean(),
  /** When this account linked Teams; null when it did not. */
  linkedAt: z.string().nullable(),
  /** The Teams display name of the linked chat; null when not linked. */
  teamsName: z.string().nullable(),
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

/**
 * The one-time secret of a pending Teams link, as the bot's link card puts it
 * in `/teams/link?token=`: 32 random bytes, base64url.
 */
export const TeamsLinkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** `POST /app/api/notifications/teams/link/preview`: what linking would do, not done yet. */
export const TeamsLinkPreview = z.object({
  /** The display name Teams gave the bot for the person in the chat. */
  teamsName: z.string(),
  /** The Microsoft Entra tenant of that Teams account. */
  tenantId: z.string(),
  expiresAt: z.string(),
});
export type TeamsLinkPreview = z.infer<typeof TeamsLinkPreview>;

/**
 * The body of `POST …/teams/link/preview` (reads) and `POST …/teams/link`
 * (consumes the token for the signed-in account). A body, never a path: a
 * path is what logs and proxies write down.
 */
export const TeamsLinkBody = z.object({ token: TeamsLinkToken });
export type TeamsLinkBody = z.infer<typeof TeamsLinkBody>;

/**
 * A Bot Framework activity, as Microsoft Teams posts it to the messaging
 * endpoint (`POST /app/api/notifications/teams/messages`). Only the fields
 * the bot reads are named; every object is LOOSE, because Microsoft adds
 * fields without notice and an unknown one must never turn a delivery into a
 * 400 that Teams would retry.
 */
const TeamsAccount = z.looseObject({
  id: z.string().max(512),
  name: z.string().max(512).optional(),
  aadObjectId: z.string().max(128).optional(),
});
export const TeamsActivity = z.looseObject({
  type: z.string().max(64),
  channelId: z.string().max(64),
  serviceUrl: z.string().max(2048),
  locale: z.string().max(32).optional(),
  from: TeamsAccount.optional(),
  recipient: TeamsAccount.optional(),
  conversation: z.looseObject({
    id: z.string().min(1).max(1024),
    conversationType: z.string().max(64).optional(),
    tenantId: z.string().max(128).optional(),
  }),
  channelData: z
    .looseObject({ tenant: z.looseObject({ id: z.string().max(128) }).optional() })
    .optional(),
  /** `installationUpdate`: `add`, `remove`, `add-upgrade`, `remove-upgrade`. */
  action: z.string().max(64).optional(),
  membersAdded: z.array(TeamsAccount).max(100).optional(),
  text: z.string().max(28_000).optional(),
});
export type TeamsActivity = z.infer<typeof TeamsActivity>;

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
