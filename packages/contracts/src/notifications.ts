/**
 * Notification catalogue shared by the API (emitters) and the web app (the
 * bell and its toasts). One definition: adding a kind on one side without
 * the other is a compile error.
 */

import { z } from "zod";

import { ActivityKindName } from "./activity.js";
import type { UserRole } from "./admin.js";
import { PoolRole } from "./pool.js";
import { SYSTEM_CHECK_KEYS } from "./health.js";

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

/**
 * The notices of a `system_alert` (ADR-055 §5), named as `nextCheckState` of
 * `@quiz/domain` returns them (the domain mirrors this list).
 */
export const SYSTEM_ALERT_STATES = ["failing", "still_failing", "recovered"] as const;

/** The project a project kind is about: its id and its name, nothing else of it. */
const projectRef = {
  projectId: z.uuid(),
  projectTitle: z.string(),
};

/**
 * Why a student's repository could not be made, as `project_provision_failed`
 * names it (F-NOTIF-13): a repository of that name exists already in the
 * organization — only the staff can resolve it — or GitHub failed, which
 * the student retries. An invitation GitHub refused is not a reason here:
 * the staff are not told of it (the student relinks their account).
 */
export const PROVISION_FAILURE_REASONS = ["repo_name_taken", "github_error"] as const;

/** What each kind carries; the web app renders the sentence from it. */
export const NotificationPayload = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pool_shared"),
    poolId: z.uuid(),
    poolName: z.string(),
    role: PoolRole,
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
     * An activity of the recipient's classroom can be done now (§c): today
     * an exercise that moved to `running`. The kind, id and title of the
     * activity, nothing of its content. Kind-neutral (ADR-030, addendum of
     * 2026-09-30): another kind reuses it without a new payload shape.
     */
    kind: z.literal("activity_available"),
    activityKind: ActivityKindName,
    activityId: z.uuid(),
    activityTitle: z.string(),
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
  /** Students took their seat in a classroom (a roster line claimed at sign-in). */
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
  // --- Projects (F-NOTIF-13, D18; merge task M3-09b). Ids and the project's
  // name only: never a score, a login or a student's name (N-SEC-20). The
  // entry opens the project (`/projects/:id`, the student's view for a
  // student).
  z.object({
    /** A project of the recipient's classroom was published (once per project). */
    kind: z.literal("project_published"),
    ...projectRef,
    /**
     * Present, and false, only when the recipient had no linked GitHub account
     * when it was sent: the text then asks to link it before accepting (M3-14d,
     * F-GH-05). Absent means linked. A boolean and nothing else (N-SEC-20);
     * frozen at sending.
     */
    githubLinked: z.literal(false).optional(),
  }),
  z.object({
    /**
     * The recipient's EFFECTIVE deadline on a project (their own, else the
     * project's) is within 24 hours, once (F-NOTIF-06's rules). No date: see
     * `deadline_approaching`.
     */
    kind: z.literal("project_deadline_reminder"),
    ...projectRef,
  }),
  z.object({
    /** Accept made the recipient's repository and the GitHub invitation awaits them. */
    kind: z.literal("project_repo_invited"),
    ...projectRef,
  }),
  z.object({
    /** The scores of a project the recipient took part in were released (the FIRST release only). */
    kind: z.literal("project_grade_final"),
    ...projectRef,
  }),
  z.object({
    /**
     * The deadline job locked (or committed on) repositories of a project
     * (staff): folded per project, `count` the repositories settled.
     */
    kind: z.literal("project_deadline_applied"),
    ...projectRef,
    count: z.number().int().positive(),
  }),
  z.object({
    /**
     * A student's repository could not be provisioned (staff): the row's
     * first failure, never an invitation GitHub refused. Folded per project;
     * `reason` the latest failure's, which names what the staff can do.
     */
    kind: z.literal("project_provision_failed"),
    ...projectRef,
    count: z.number().int().positive(),
    reason: z.enum(PROVISION_FAILURE_REASONS),
  }),
  z.object({
    /**
     * The organization of a classroom was deleted on GitHub, or Quiz's App
     * uninstalled from it (staff, F-PROJ-18): one entry per classroom
     * linked to it. Opens the classroom's Settings.
     */
    kind: z.literal("github_org_lost"),
    classroomId: z.uuid(),
    classroomName: z.string(),
    orgLogin: z.string(),
  }),
  z.object({
    /**
     * Health checks of the platform changed state (ADR-055 §5), told to the
     * administrators by the `health.checks` task: `failing` after two failed
     * runs in a row, `still_failing` a day later, `recovered` once OK again
     * after an alert. Which checks, by key only: their causes and measures
     * are on the System status page the notification opens.
     */
    kind: z.literal("system_alert"),
    state: z.enum(SYSTEM_ALERT_STATES),
    checks: z.array(z.enum(SYSTEM_CHECK_KEYS)).min(1),
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
  "project_published",
  "project_deadline_reminder",
  "project_repo_invited",
  "project_grade_final",
  "student_joined",
  "roster_conflict",
  "grading_ready",
  "project_deadline_applied",
  "project_provision_failed",
  "github_org_lost",
  "pool_shared",
  "pool_ownership",
  "pool_question_added",
  "system_alert",
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
  // The project kinds (F-NOTIF-13, ADR-030): on everywhere for what a
  // student or a teacher must not miss, off outside the app for the news
  // that can wait for the next visit.
  project_published: { bell: true, email: false, teams: false },
  project_deadline_reminder: { bell: true, email: true, teams: true },
  project_repo_invited: { bell: true, email: true, teams: true },
  project_grade_final: { bell: true, email: true, teams: true },
  student_joined: { bell: true, email: false, teams: false },
  roster_conflict: { bell: true, email: true, teams: true },
  grading_ready: { bell: true, email: true, teams: true },
  project_deadline_applied: { bell: true, email: false, teams: false },
  project_provision_failed: { bell: true, email: true, teams: true },
  github_org_lost: { bell: true, email: true, teams: true },
  pool_shared: { bell: true, email: true, teams: true },
  pool_ownership: { bell: true, email: true, teams: true },
  pool_question_added: { bell: true, email: false, teams: false },
  // The secondary alarm of the operator (ADR-055 §5): the e-mail is the point.
  // Teams stays off: `KIND_CHANNELS` forbids it (a test holds every default to it).
  system_alert: { bell: true, email: true, teams: false },
};

/**
 * The channels a kind may use, when it may not use them all. `notifyMany`
 * never delivers a kind elsewhere, and the settings grid shows no toggle
 * there. `system_alert` has no Teams activity type: declaring one would bump
 * the Teams app for every user, for a notice a handful of administrators
 * receive by e-mail anyway (ADR-030, addendum of 2026-09-30).
 */
export const KIND_CHANNELS = {
  system_alert: ["bell", "email"],
} as const satisfies Partial<Record<NotificationKind, readonly NotificationChannel[]>>;

/** The channels `kind` may use (`KIND_CHANNELS`, every channel otherwise). */
export function kindChannels(kind: NotificationKind): readonly NotificationChannel[] {
  const limited: Partial<Record<NotificationKind, readonly NotificationChannel[]>> = KIND_CHANNELS;
  return limited[kind] ?? NOTIFICATION_CHANNELS;
}

/** The kinds `KIND_CHANNELS` keeps out of Teams. */
type NoTeamsKind = {
  [K in keyof typeof KIND_CHANNELS]: "teams" extends (typeof KIND_CHANNELS)[K][number] ? never : K;
}[keyof typeof KIND_CHANNELS];

/** The kinds Teams may carry: the Teams app declares an activity type for each. */
export type TeamsNotificationKind = Exclude<NotificationKind, NoTeamsKind>;

/**
 * Who a kind is sent to. `seat`: the claimed STUDENT seats of a classroom
 * (`enrollments.staff = false`), whatever the account's global role — a
 * teacher or an admin on a colleague's roster holds one too. `course`: the
 * staff seats of a course (`course_staff`: `tellStaff`, `staffOf`), never a
 * seatless admin. `pool`: pool owners and members, which only a teacher or an
 * admin reaches. `admin`: the accounts whose role is admin (the platform's
 * health, ADR-055 §5). A kind added to {@link NOTIFICATION_KINDS} without its
 * row here is a compile error.
 */
export const NOTIFICATION_AUDIENCE: Readonly<
  Record<NotificationKind, "seat" | "course" | "pool" | "admin">
> = {
  results_released: "seat",
  activity_scheduled: "seat",
  activity_available: "seat",
  deadline_approaching: "seat",
  results_updated: "seat",
  project_published: "seat",
  project_deadline_reminder: "seat",
  project_repo_invited: "seat",
  project_grade_final: "seat",
  student_joined: "course",
  roster_conflict: "course",
  grading_ready: "course",
  project_deadline_applied: "course",
  project_provision_failed: "course",
  github_org_lost: "course",
  pool_shared: "pool",
  pool_ownership: "pool",
  pool_question_added: "pool",
  system_alert: "admin",
};

/**
 * The kinds only a platform with Quiz's GitHub App ever sends (projects,
 * F-NOTIF-13): without the App there is no project and no organization, so
 * their toggles would control nothing (ADR-030: a kind enters the settings
 * with its emitter). Every other kind is sent whatever the configuration.
 */
export const GITHUB_KINDS = [
  "project_published",
  "project_deadline_reminder",
  "project_repo_invited",
  "project_grade_final",
  "project_deadline_applied",
  "project_provision_failed",
  "github_org_lost",
] as const satisfies readonly NotificationKind[];
const githubKinds: readonly NotificationKind[] = GITHUB_KINDS;

/**
 * The kinds an account can receive, as the settings grid lists them (ADR-030
 * §f: a toggle for a kind that sends nothing is a lie). A student always sees
 * the seat kinds, before the first seat is claimed too; a teacher or an admin
 * sees the pool kinds, and the seat kinds only while holding a student seat.
 * The course kinds go to a teacher, whose course seat may come at any time,
 * and to an admin only while holding one: without it they are a row that
 * controls nothing (#287). The admin kinds go to an admin, and only there.
 * The GitHub kinds ({@link GITHUB_KINDS}) only on a platform with the App.
 */
export function notificationKindsFor({
  role,
  studentSeat,
  courseSeat,
  github,
}: {
  role: UserRole;
  /** A claimed student seat (`enrollments.staff = false`). */
  studentSeat: boolean;
  /** A seat on a course staff (`course_staff`). */
  courseSeat: boolean;
  /** The platform has Quiz's GitHub App configured (`GITHUB_APP_ID`). */
  github: boolean;
}): NotificationKind[] {
  const reaches = {
    seat: role === "student" || studentSeat,
    course: role === "teacher" || (role === "admin" && courseSeat),
    pool: role !== "student",
    admin: role === "admin",
  };
  return NOTIFICATION_KINDS.filter((kind) => reaches[NOTIFICATION_AUDIENCE[kind]] && (github || !githubKinds.includes(kind)));
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
