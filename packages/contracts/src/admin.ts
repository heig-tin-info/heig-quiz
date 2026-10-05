/**
 * `admin` route schemas (F-ADMIN-01, F-ADMIN-06): the teacher grants, the
 * list of every account on the platform, and the scheduled tasks.
 */
import { z } from "zod";

/** `POST /app/api/admin/teachers` — grant the teacher role to an address. */
export const TeacherGrantCreate = z.object({ email: z.email() });
export type TeacherGrantCreate = z.infer<typeof TeacherGrantCreate>;

/** `DELETE /app/api/admin/teachers/:gid`. */
export const TeacherGrantParams = z.object({ gid: z.uuid() });
export type TeacherGrantParams = z.infer<typeof TeacherGrantParams>;

export const USER_ROLES = ["student", "teacher", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * WHY an account is teacher or admin, as `roleForIdentity` (apps/api
 * roles.ts) decides it, in the order it tries them: the super-admin address,
 * an admin's grant on one of the account's addresses, a seat on a course
 * staff, an edu-ID `staff` affiliation of one of our institutions.
 */
export const ROLE_REASONS = ["super_admin", "grant", "course_seat", "staff_affiliation"] as const;
export type RoleReason = (typeof ROLE_REASONS)[number];

/** One row of `GET /app/api/admin/users`. Anonymized accounts are never listed. */
export const AdminUser = z.object({
  id: z.uuid(),
  email: z.string(),
  givenName: z.string(),
  familyName: z.string(),
  /** Upload, else IdP picture; null with neither (the client draws initials). */
  avatarUrl: z.string().nullable(),
  /** The STORED role, the one every guard reads. */
  role: z.enum(USER_ROLES),
  /**
   * Why the rule makes this account teacher or admin; `null` for a student,
   * and for an account whose stored role the rule no longer gives (it is
   * recomputed at the next sign-in).
   */
  reason: z.enum(ROLE_REASONS).nullable(),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** Pools this account owns. */
  pools: z.number().int(),
  /** Live questions in those pools. */
  questions: z.number().int(),
  /** Non-archived classrooms of the courses where the account holds a staff seat. */
  classrooms: z.number().int(),
});
export type AdminUser = z.infer<typeof AdminUser>;

/**
 * The scheduled tasks (F-ADMIN-06; D10, merge task M2-05): the minutes-scale
 * periodic work of the server, which an administrator sees, pauses,
 * re-periods and runs now. The catalog lives in the server
 * (`SCHEDULED_TASKS`, `apps/api/src/modules/system/catalog.ts`); its keys are this closed
 * list, so the screen that names each task has an English and a French name
 * for every one of them, or does not compile. The clock-bound work of the
 * ticker (`live.*`) is NOT here and never will be: invariant 5 must not
 * depend on an admin setting.
 */
export const SCHEDULED_TASK_KEYS = [
  "sessions.purge",
  "oauth.purge",
  "poll.end_idle",
  "notifications.deadline_reminders",
  "drill.purge",
  "health.checks",
  "reconcile.deliveries",
  "deliveries.purge",
  "reconcile.grades",
  "reconcile.repos",
  "llm.review",
] as const;
export type ScheduledTaskKey = (typeof SCHEDULED_TASK_KEYS)[number];

/** `running` from the claim until the run ends; `null` for a task never run. */
export const SCHEDULED_TASK_STATUSES = ["running", "ok", "error"] as const;
export type ScheduledTaskStatus = (typeof SCHEDULED_TASK_STATUSES)[number];

/** The period an administrator may set: one minute to one week. */
export const TASK_INTERVAL_MIN_MINUTES = 1;
export const TASK_INTERVAL_MAX_MINUTES = 7 * 24 * 60;

/**
 * `/app/api/admin/tasks/:key`. A plain string, not the enum: a key the
 * catalog does not hold is a 404, like any missing entity, not a 400.
 */
export const ScheduledTaskParams = z.object({ key: z.string().min(1).max(100) });
export type ScheduledTaskParams = z.infer<typeof ScheduledTaskParams>;

/** `PATCH /app/api/admin/tasks/:key`: at least one of the two. */
export const ScheduledTaskPatch = z
  .strictObject({
    enabled: z.boolean().optional(),
    intervalMinutes: z
      .number()
      .int()
      .min(TASK_INTERVAL_MIN_MINUTES)
      .max(TASK_INTERVAL_MAX_MINUTES)
      .optional(),
  })
  .refine((b) => b.enabled !== undefined || b.intervalMinutes !== undefined, {
    message: "Nothing to update",
  });
export type ScheduledTaskPatch = z.infer<typeof ScheduledTaskPatch>;

/** One row of `GET /app/api/admin/tasks`: the catalog joined to its stored state. */
export const AdminScheduledTask = z.object({
  key: z.enum(SCHEDULED_TASK_KEYS),
  enabled: z.boolean(),
  intervalMinutes: z.number().int(),
  defaultIntervalMinutes: z.number().int(),
  lastRunAt: z.iso.datetime().nullable(),
  lastStatus: z.enum(SCHEDULED_TASK_STATUSES).nullable(),
  /**
   * The last run's summary ("3 sessions deleted") or its error, in English:
   * operator data, like a log line, never translated.
   */
  lastMessage: z.string().nullable(),
  lastDurationMs: z.number().int().nullable(),
  lastOkAt: z.iso.datetime().nullable(),
  /**
   * When the ticker claims it next (the database clock: the last run plus
   * the period, or now for a task never run); `null` while disabled.
   */
  nextRunAt: z.iso.datetime().nullable(),
});
export type AdminScheduledTask = z.infer<typeof AdminScheduledTask>;
