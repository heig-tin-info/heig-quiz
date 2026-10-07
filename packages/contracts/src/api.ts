/**
 * API payload types shared by the API (producers) and the web app
 * (consumers). Wire format: dates travel as ISO strings. Any payload drift
 * becomes a compile error on the side that diverges.
 */

import { z } from "zod";

import { TRUSTED_CLIENTS } from "@quiz/domain";

import { McqPolicy } from "./evaluation.js";
import type { TeacherCodespaceGrant } from "./codespace.js";
import type { CourseRole } from "./org.js";

/** Display format for date-times; null falls back to ISO (`2026-09-01 08:00`). */
export const DATE_FORMATS = ["iso", "eu", "uk", "us"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

/**
 * The single unauthenticated endpoint (`GET /app/api/config`): what the
 * sign-in screen needs to know before anyone has a session. It carries no
 * personal data and no secret.
 */
export interface PublicConfig {
  /** The API exposes the persona picker at `/app/auth/dev` (never in prod). */
  devLogin: boolean;
  /**
   * The kiosk path (ADR-051), null when `KIOSK_ATTESTATION` is `off`. Present,
   * an exam may accept kiosk stations and the setting is offered;
   * `extensionId` is the companion extension the `/kiosk` page talks to (null
   * when not configured), and `mock` says the attestation is the development
   * fixture, which answers `mock:<device id>` instead of asking an extension.
   */
  kiosk: { extensionId: string | null; mock: boolean } | null;
}

/**
 * What a browser session is (ADR-027). `portal`: the ordinary sign-in, the
 * whole application. `seb`: opened by a one-time launch ticket inside Safe
 * Exam Browser, confined to ONE activity: an evaluation, or an `online_seb`
 * project's page and workspace (D21, M6-07). `impersonation`: an admin acting
 * as a student (ADR-034), opened by a one-time link, reaching what a
 * `portal` session of that student reaches, read-only in production.
 * `kiosk`: opened on one of the school's attested stations by a pairing
 * (ADR-051), confined to ONE evaluation like `seb`. `seb` and `kiosk` are the
 * confined kinds, the trusted clients an exam may require. A route accepts
 * `portal` (and so `impersonation`) only unless it declares otherwise.
 */
export const SESSION_KINDS = ["portal", "impersonation", ...TRUSTED_CLIENTS] as const;
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
  /** The on-screen calculator works in RPN (ADR-069); null means no, the infix one. */
  rpnCalculator: boolean | null;
  /**
   * The session this request rode on; `evaluationId` is set on a confined
   * one only (`seb` or `kiosk`, the evaluation it is confined to), or
   * `projectId` instead (a `seb` session of an `online_seb` project, D21),
   * and `readOnly` says the server refuses its writes (an
   * `impersonation` outside development, ADR-034). Absent: `portal`.
   * `superPowersUntil` is the server's end of this session's Super Powers
   * (ADR-054), ISO; null when they are off. The browser only counts down
   * to it for display: the server decides, by its own clock.
   */
  session?: {
    kind: SessionKind;
    evaluationId: string | null;
    projectId: string | null;
    readOnly: boolean;
    superPowersUntil: string | null;
    /** This session may switch Super Powers on: an admin's own portal session (ADR-054). */
    superPowersAvailable: boolean;
  };
}

/**
 * `POST /app/api/me/super-powers` switches them on for one hour, and
 * `DELETE` off (ADR-054): an admin's own portal session reaches every
 * course and pool until then. Neither takes a body; both answer this.
 */
export const SuperPowersState = z.object({ superPowersUntil: z.string().nullable() });
export type SuperPowersState = z.infer<typeof SuperPowersState>;

/**
 * `POST /app/api/classrooms/:id/roster/:eid/impersonation` (ADR-034): the
 * one-time link that opens a session as this student, for an admin to paste
 * into a private window. Valid five minutes, once.
 */
export interface ImpersonationLink {
  url: string;
}

/**
 * The path parameter of a one-time link (`/app/auth/as/:secret`): 32 random
 * bytes in base64url, nothing else reaches the database.
 */
export const LaunchSecretParams = z.object({ secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

/** A coach mark's id: `<screen>.<step>`, lower case (`pool.new-question`). */
const CoachId = z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)*$/).max(64);

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
    rpnCalculator: z.boolean().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" });
export type MePatch = z.infer<typeof MePatch>;

// --- Courses and classrooms (teacher) ---

interface CourseStaffMember {
  userId: string;
  givenName: string;
  familyName: string;
  email: string;
  avatarUrl: string | null;
  role: CourseRole;
}

export interface ClassroomSummary {
  id: string;
  name: string;
  period: string;
  /** First and last month of the period (`YYYY-MM`), or both null (F-ORG-03). */
  periodStart: string | null;
  periodEnd: string | null;
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
  /**
   * The caller hid this course from their own navigation (#155, ADR-032):
   * the course list, the sidebar and the command palette leave it out, the
   * pickers keep it. Per user, never seen by the other staff members.
   */
  hidden: boolean;
  /** How many evaluation templates the course keeps (ADR-031). */
  templates: number;
  /** Non-archived classrooms of this course, oldest first. */
  classrooms: ClassroomSummary[];
  staff: CourseStaffMember[];
  /**
   * What the caller may do on this course (ADR-068): `owner` under Super
   * Powers, otherwise their seat's role. The screens hide what only an
   * owner may do; the routes refuse it anyway (`owner_required`).
   */
  myRole: CourseRole;
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
  /** The student's linked GitHub login (F-GH-05); null unless the classroom is connected to GitHub. */
  githubLogin: string | null;
}

export interface ClassroomDetail {
  id: string;
  name: string;
  period: string;
  periodStart: string | null;
  periodEnd: string | null;
  archivedAt: string | null;
  /** ADR-041 §6: the teacher enabled the drill for this classroom (`PUT /classrooms/:id/drill`). */
  drillEnabled: boolean;
  course: { id: string; name: string; code: string };
  roster: RosterEntry[];
}

// --- Administration ---

export interface AdminTeacher {
  id: string;
  email: string;
  grantedAt: string;
  givenName: string | null;
  familyName: string | null;
  lastLoginAt: string | null;
  /** Upload, else IdP picture; null before the first sign-in or with neither. */
  avatarUrl: string | null;
  signedUp: boolean;
  courses: number;
  /** The online workspace grant (ADR-047 §4); null when the feature is off (`CODESPACE_URL` empty). */
  codespace: TeacherCodespaceGrant | null;
}
