/**
 * API payload types shared by the API (producers) and the web app
 * (consumers). Wire format: dates travel as ISO strings. Any payload drift
 * becomes a compile error on the side that diverges.
 */

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
}

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
