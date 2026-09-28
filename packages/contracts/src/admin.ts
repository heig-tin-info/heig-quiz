/**
 * `admin` route schemas (F-ADMIN-01): the teacher grants, and the list of
 * every account on the platform.
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
