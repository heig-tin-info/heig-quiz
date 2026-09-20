import { z } from "zod";

/** Global application roles. */
export const Role = z.enum(["student", "teacher", "admin"]);
export type Role = z.infer<typeof Role>;

/** A course: the unit a staff, a pool and a set of classrooms hang off. */
export const CourseCreate = z.object({
  name: z.string().min(1).max(200),
  /** Short school code (`PRG1`); normalized to upper case server-side. */
  code: z.string().min(1).max(32),
});
export type CourseCreate = z.infer<typeof CourseCreate>;

export const CoursePatch = CourseCreate.partial().refine(
  (b) => Object.keys(b).length > 0,
  { message: "Nothing to update" },
);
export type CoursePatch = z.infer<typeof CoursePatch>;

export const ClassroomCreate = z.object({
  name: z.string().min(1).max(200),
  period: z.string().max(64).default(""),
});
export type ClassroomCreate = z.infer<typeof ClassroomCreate>;

export const ClassroomPatch = z
  .object({
    name: z.string().min(1).max(200).optional(),
    period: z.string().max(64).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" });
export type ClassroomPatch = z.infer<typeof ClassroomPatch>;

/** Status of a roster entry. */
export const EnrollmentStatus = z.enum(["pending", "claimed"]);
export type EnrollmentStatus = z.infer<typeof EnrollmentStatus>;

export const EnrollmentPatch = z
  .object({
    nom: z.string().min(1).max(200).optional(),
    prenom: z.string().min(1).max(200).optional(),
    email: z.email().optional(),
    /** Accommodation: extra time in percent of the nominal duration. */
    timeBonusPercent: z.number().int().min(0).max(300).optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" });
export type EnrollmentPatch = z.infer<typeof EnrollmentPatch>;
