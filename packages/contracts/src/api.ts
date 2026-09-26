/**
 * API payload types shared by the API (producers) and the web app
 * (consumers). Wire format: dates travel as ISO strings. Any payload drift
 * becomes a compile error on the side that diverges.
 */

import { z } from "zod";

import { McqPolicy } from "./evaluation.js";

/** Display format for date-times; null falls back to ISO (`2026-09-01 08:00`). */
export const DATE_FORMATS = ["iso", "eu", "uk", "us"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export function isDateFormat(v: unknown): v is DateFormat {
  return typeof v === "string" && (DATE_FORMATS as readonly string[]).includes(v);
}

/**
 * The single unauthenticated endpoint (`GET /app/api/config`): what the
 * sign-in screen needs to know before anyone has a session. It carries no
 * personal data and no secret.
 */
export interface PublicConfig {
  /** The API exposes the persona picker at `/app/auth/dev` (never in prod). */
  devLogin: boolean;
}

/**
 * What a browser session is (ADR-027). `portal`: the ordinary sign-in, the
 * whole application. `seb`: opened by a one-time launch ticket inside Safe
 * Exam Browser, confined to ONE evaluation. A route accepts `portal` only
 * unless it declares otherwise.
 */
export const SESSION_KINDS = ["portal", "seb"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export interface Me {
  id: string;
  email: string;
  givenName: string;
  familyName: string;
  role: "teacher" | "student" | "admin";
  lastLoginAt: string | null;
  avatarUrl: string | null;
  hasUploadedAvatar: boolean;
  locale: "en" | "fr" | null;
  dateFormat: DateFormat | null;
  /**
   * Default MCQ scoring policy for the evaluations this user creates; null
   * means `all_or_nothing`. Only the creation of an evaluation reads it —
   * changing it never moves an evaluation that already exists.
   */
  mcqPolicy: McqPolicy | null;
  /**
   * The coach marks: whether they are shown (null means yes) and the ids of
   * those already read or dismissed. Kept on the account, not in the
   * browser, so a teacher who met a screen on their laptop is not taught it
   * again on the classroom's PC.
   */
  coach: { enabled: boolean | null; seen: string[] };
  /** The session this request rode on; `evaluationId` is set on a `seb` one only. Absent: `portal`. */
  session?: { kind: SessionKind; evaluationId: string | null };
}

/** A coach mark's id: `<screen>.<step>`, lower case (`pool.new-question`). */
export const CoachId = z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)*$/).max(64);

/**
 * `POST /app/api/me/coach` — coach marks marked as seen (merged into the set,
 * never replacing it: two tabs each reporting their own must not lose the
 * other's), or the whole set forgotten (`reset`, "Show the tips again").
 */
export const CoachSeenPatch = z.union([
  z.object({ seen: z.array(CoachId).min(1).max(50) }).strict(),
  z.object({ reset: z.literal(true) }).strict(),
]);
export type CoachSeenPatch = z.infer<typeof CoachSeenPatch>;

/**
 * `PATCH /app/api/me` — the account preferences, persisted server-side so
 * they follow the user across devices (invariant 7: the route validates with
 * this schema and the SPA sends what it types).
 *
 * Every field is optional and each one is nullable: a null is "no preference,
 * fall back to the default", which is a value the user can set back.
 */
export const MePatch = z
  .object({
    locale: z.enum(["en", "fr"]).nullable().optional(),
    dateFormat: z.enum(DATE_FORMATS).nullable().optional(),
    mcqPolicy: McqPolicy.nullable().optional(),
    coachEnabled: z.boolean().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" });
export type MePatch = z.infer<typeof MePatch>;

// --- Courses and classrooms (teacher) ---

export interface CourseStaffMember {
  userId: string;
  givenName: string;
  familyName: string;
  email: string;
  avatarUrl: string | null;
}

export interface ClassroomSummary {
  id: string;
  name: string;
  period: string;
  courseId: string;
  courseName: string;
  courseCode: string;
  createdAt: string;
  archivedAt: string | null;
  students: number;
  claimed: number;
}

export interface CourseSummary {
  id: string;
  name: string;
  code: string;
  createdAt: string;
  /** Non-archived classrooms of this course, oldest first. */
  classrooms: ClassroomSummary[];
  staff: CourseStaffMember[];
}

export interface RosterEntry {
  id: string;
  nom: string;
  prenom: string;
  email: string;
  status: "pending" | "claimed";
  conflictFlag: boolean;
  staff: boolean;
  /** Accommodation: extra time in percent of the nominal duration (0 = none). */
  timeBonusPercent: number;
  note: string | null;
  lastLoginAt: string | null;
  avatarUrl: string | null;
  userId: string | null;
}

export interface ClassroomDetail {
  id: string;
  name: string;
  period: string;
  archivedAt: string | null;
  course: { id: string; name: string; code: string };
  roster: RosterEntry[];
}

// --- Student side ---

export interface StudentClassroom {
  id: string;
  name: string;
  period: string;
  courseName: string;
  courseCode: string;
  /** Teaching staff, for the student to know whom they are working with. */
  teachers: string[];
  timeBonusPercent: number;
}

// --- Administration ---

export interface AdminTeacher {
  id: string;
  email: string;
  grantedAt: string;
  givenName: string | null;
  familyName: string | null;
  lastLoginAt: string | null;
  signedUp: boolean;
  courses: number;
}
