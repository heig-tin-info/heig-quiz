/**
 * Notification catalogue shared by the API (emitters) and the web app (the
 * bell and its toasts). One definition: adding a kind on one side without
 * the other is a compile error.
 */

import { z } from "zod";

/**
 * Persistent, per-account notifications (the App channel: the bell, and a
 * toast in every open tab when one arrives — ADR-030, addendum §a): stored
 * by the API, listed and marked read over HTTP, refreshed through a
 * `notifications` hint on the user's own topic.
 */

/**
 * The payload of the kinds folded per classroom (ADR-030 §e): a count, no
 * name and no address — once folded the names are lost anyway, and the bell
 * opens the roster, where they are.
 */
const classroomCount = {
  classroomId: z.uuid(),
  classroomName: z.string(),
  count: z.number().int().positive(),
};

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
  /**
   * Exercises of the recipient's classroom were scheduled for the first time
   * (ADR-030, addendum §c and §h), folded per classroom: "16 exercises
   * scheduled in PRG1-2026". Never an exam, never a poll.
   */
  z.object({ kind: z.literal("activity_scheduled"), ...classroomCount }),
  z.object({
    /**
     * An exercise of the recipient's classroom moved to `running` (§c): it
     * can be taken now. The title and the id of the evaluation, nothing of
     * its content.
     */
    kind: z.literal("activity_available"),
    evaluationId: z.uuid(),
    evaluationTitle: z.string(),
  }),
  z.object({
    /**
     * An evaluation the recipient has not submitted closes within 24 hours
     * (ADR-030, addendum §d): sent once per (evaluation, student) by the
     * ticker's scan. No `closesAt`: the e-mail would have to render a date in
     * the recipient's time zone, and "within 24 hours" says what matters.
     */
    kind: z.literal("deadline_approaching"),
    evaluationId: z.uuid(),
    evaluationTitle: z.string(),
  }),
  z.object({
    /**
     * The final grade of a RELEASED evaluation the recipient took changed
     * (F-GRADE-09, ADR-030 addendum §c and §h.4): a correction moved it to
     * another grade on the evaluation's scale. Folded per evaluation (§e),
     * hence `count`, the corrections folded into the entry. Never the grade,
     * old or new: it is read on the feedback page, behind the student's own
     * session, exactly as for `results_released`.
     */
    kind: z.literal("results_updated"),
    evaluationId: z.uuid(),
    evaluationTitle: z.string(),
    /** The attempt that counts, whose feedback page the notification opens. */
    attemptId: z.uuid(),
    count: z.number().int().positive(),
  }),
  /** Students took their seat in a classroom (join code, or a roster claim). */
  z.object({ kind: z.literal("student_joined"), ...classroomCount }),
  /** Roster lines of a classroom were flagged for the teacher's decision (AU-21). */
  z.object({ kind: z.literal("roster_conflict"), ...classroomCount }),
  z.object({
    /**
     * The automatic grading of an evaluation finished and proposals remain
     * for the staff to validate (ADR-030, addendum §c). How many, never
     * whose, and never a grade.
     */
    kind: z.literal("grading_ready"),
    evaluationId: z.uuid(),
    evaluationTitle: z.string(),
    count: z.number().int().positive(),
  }),
  z.object({
    /**
     * Colleagues published questions (a first version or a new one) in a
     * pool the recipient owns or contributes to, folded per pool (§e).
     */
    kind: z.literal("pool_question_added"),
    poolId: z.uuid(),
    poolName: z.string(),
    count: z.number().int().positive(),
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
export const NOTIFICATION_KINDS = [
  "results_released",
  "activity_scheduled",
  "activity_available",
  "deadline_approaching",
  "results_updated",
  "student_joined",
  "roster_conflict",
  "grading_ready",
  "pool_shared",
  "pool_ownership",
  "pool_question_added",
] as const;
export const NotificationKind = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKind>;

/**
 * Where one notification may go: the app (`bell`: the inbox, plus a toast in
 * every open tab as it arrives), an e-mail
 * to the account's address, a Microsoft Teams chat message once the account
 * has linked Teams.
 */
export const NOTIFICATION_CHANNELS = ["bell", "email", "teams"] as const;
export const NotificationChannel = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof NotificationChannel>;

/**
 * What a user who never touched a toggle gets, per kind (ADR-030, addendum of
 * #198). A kind a user must not miss is on everywhere; a background-noise kind
 * (a student joined, a question added to a shared pool) stays in the app and
 * is off by e-mail and Teams. Teams only applies once the account is linked,
 * so "on" there costs nothing until then. A kind added to
 * {@link NOTIFICATION_KINDS} without its row here is a compile error.
 */
export const DEFAULT_CHANNEL_ENABLED: Readonly<
  Record<NotificationKind, Readonly<Record<NotificationChannel, boolean>>>
> = {
  results_released: { bell: true, email: true, teams: true },
  // A term of exercises scheduled in one sitting must not send a class
  // sixteen e-mails (§h.1).
  activity_scheduled: { bell: true, email: false, teams: false },
  // On, but only a take-home exercise leaves the app: an in-class one opens
  // with the students in the room (§h.3, the `channels` of `notifyMany`).
  activity_available: { bell: true, email: true, teams: true },
  // A reminder a student must not miss (§c).
  deadline_approaching: { bell: true, email: true, teams: true },
  // A correction after the release: the bell, folded per evaluation; the
  // student already had the e-mail of the release (§h.5).
  results_updated: { bell: true, email: false, teams: false },
  student_joined: { bell: true, email: false, teams: false },
  roster_conflict: { bell: true, email: true, teams: true },
  grading_ready: { bell: true, email: true, teams: true },
  pool_shared: { bell: true, email: true, teams: true },
  pool_ownership: { bell: true, email: true, teams: true },
  pool_question_added: { bell: true, email: false, teams: false },
};

/**
 * Who a kind is sent to. `seat`: the claimed STUDENT seats of a classroom
 * (`enrollments.staff = false`), whatever the account's global role — a
 * teacher or an admin on a colleague's roster holds one too. `staff`: staff
 * seats, pool owners and sharees, which only a teacher or an admin reaches.
 * A kind added to {@link NOTIFICATION_KINDS} without its row here is a
 * compile error.
 */
export const NOTIFICATION_AUDIENCE: Readonly<Record<NotificationKind, "seat" | "staff">> = {
  results_released: "seat",
  activity_scheduled: "seat",
  activity_available: "seat",
  deadline_approaching: "seat",
  results_updated: "seat",
  student_joined: "staff",
  roster_conflict: "staff",
  grading_ready: "staff",
  pool_shared: "staff",
  pool_ownership: "staff",
  pool_question_added: "staff",
};

/**
 * The kinds an account can receive, as the settings grid lists them (ADR-030
 * §f: a toggle for a kind that sends nothing is a lie). A student always sees
 * the seat kinds, before the first seat is claimed too; a teacher or an admin
 * sees the staff kinds, and the seat kinds only while holding a student seat.
 */
export function notificationKindsFor(
  role: "student" | "teacher" | "admin",
  holdsStudentSeat: boolean,
): NotificationKind[] {
  const seat = role === "student" || holdsStudentSeat;
  const staff = role !== "student";
  return NOTIFICATION_KINDS.filter((kind) =>
    NOTIFICATION_AUDIENCE[kind] === "seat" ? seat : staff,
  );
}

/** The resolved grid: every kind × every channel, defaults filled in. */
export const NotificationMatrix = z.record(
  NotificationKind,
  z.record(NotificationChannel, z.boolean()),
);
export type NotificationMatrix = z.infer<typeof NotificationMatrix>;

/** The Teams link as the settings card shows it. */
const TeamsLinkStatus = z.object({
  /** The platform has its Teams application configured (`TEAMS_*` env). */
  available: z.boolean(),
  /** When this account linked Teams; null when it did not. */
  linkedAt: z.string().nullable(),
  /** The display name of the linked Teams account; null when not linked. */
  teamsName: z.string().nullable(),
  /**
   * Its sign-in name (the Microsoft account's e-mail); null when not linked,
   * or when Teams did not give one (a link made before it was recorded).
   */
  teamsUsername: z.string().nullable(),
});
type TeamsLinkStatus = z.infer<typeof TeamsLinkStatus>;

/** `GET /app/api/notifications/settings`. */
export const NotificationSettings = z.object({
  matrix: NotificationMatrix,
  /** The rows of the grid: the kinds this account can receive (`notificationKindsFor`). */
  kinds: z.array(NotificationKind),
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
 * The one-time secret of a pending Teams link, as the HEIG Quiz tab in Teams
 * puts it in `/teams/link?token=`: 32 random bytes, base64url.
 */
export const TeamsLinkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** `POST /app/api/notifications/teams/link/preview`: what linking would do, not done yet. */
export const TeamsLinkPreview = z.object({
  /** The display name of the Teams account (the SSO token's `name`). */
  teamsName: z.string(),
  /**
   * Its sign-in name, usually the Microsoft account's e-mail (the token's
   * `preferred_username`); null when the token carried none. Shown, never
   * compared with the Quiz account's address.
   */
  teamsUsername: z.string().nullable(),
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
 * `POST /app/api/notifications/teams/tab`: what the HEIG Quiz tab in Teams
 * shows, for the Teams account its SSO token names. Linked: to which Quiz
 * account. Not linked: a fresh single-use link to open in the browser, where
 * the Quiz session lives (`/teams/link?token=…`).
 */
export const TeamsTabState = z.discriminatedUnion("state", [
  z.object({ state: z.literal("linked"), accountName: z.string() }),
  z.object({ state: z.literal("unlinked"), linkUrl: z.string() }),
]);
export type TeamsTabState = z.infer<typeof TeamsTabState>;

/**
 * The catalogue of kinds and the payload union are one list: a kind added to
 * the union and not to {@link NOTIFICATION_KINDS} (or the reverse) makes this
 * type `false`, and the assignment below a compile error.
 */
type KindsMatchPayloads = [NotificationPayload["kind"]] extends [NotificationKind]
  ? [NotificationKind] extends [NotificationPayload["kind"]]
    ? true
    : false
  : false;
const KINDS_MATCH_PAYLOADS: KindsMatchPayloads = true;
