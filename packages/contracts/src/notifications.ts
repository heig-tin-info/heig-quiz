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
