/**
 * `org` route schemas (PLAN-MVP §4.1): courses, their staff and pools,
 * classrooms, the join code and the roster.
 *
 * This file used to be `classroom.ts`; the names are unchanged, so the web
 * app keeps importing them from the package root.
 */
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
    /**
     * Self-enrolment switch (F-ORG-06). Turning it on mints a join code if
     * the classroom has none; turning it off keeps the code but refuses it.
     */
    joinCodeEnabled: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" });
export type ClassroomPatch = z.infer<typeof ClassroomPatch>;

/** Archive switch of a classroom (`POST /classrooms/:id/archive`). */
export const ClassroomArchive = z.object({ archived: z.boolean().default(true) });
export type ClassroomArchive = z.infer<typeof ClassroomArchive>;

/** What a teacher sees of the join code; `joinCode` is null while disabled and unminted. */
export const JoinCodeState = z.object({
  joinCode: z.string().nullable(),
  joinCodeEnabled: z.boolean(),
});
export type JoinCodeState = z.infer<typeof JoinCodeState>;

/** `POST /app/api/join/:code` — the student side of F-ORG-06. */
export const JoinParams = z.object({ code: z.string().trim().min(4).max(32) });
export type JoinParams = z.infer<typeof JoinParams>;

export const JoinResult = z.object({
  classroomId: z.uuid(),
  classroomName: z.string(),
  courseCode: z.string(),
  /** `joined` on the first pass, `already` when the seat was already claimed. */
  status: z.enum(["joined", "already"]),
});
export type JoinResult = z.infer<typeof JoinResult>;

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

/** `PUT /courses/:id/pools` — the whole set of pools the course draws from. */
export const CoursePoolsPut = z.object({ poolIds: z.array(z.uuid()).max(50) });
export type CoursePoolsPut = z.infer<typeof CoursePoolsPut>;

export const CourseRef = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string(),
});
export type CourseRef = z.infer<typeof CourseRef>;

export const StaffMember = z.object({
  userId: z.uuid(),
  givenName: z.string(),
  familyName: z.string(),
  email: z.string(),
});
export type StaffMember = z.infer<typeof StaffMember>;

export const ClassroomRef = z.object({
  id: z.uuid(),
  name: z.string(),
  period: z.string(),
  archivedAt: z.string().nullable(),
  joinCode: z.string().nullable(),
  joinCodeEnabled: z.boolean(),
});
export type ClassroomRef = z.infer<typeof ClassroomRef>;

/** `GET /courses/:id` (PLAN-MVP §4.1 `CourseDetail`). */
export const CourseDetail = z.object({
  course: CourseRef,
  staff: z.array(StaffMember),
  /** Pools linked to the course, in name order (see `@quiz/contracts` pool.ts). */
  pools: z.array(
    z.object({ id: z.uuid(), name: z.string(), visibility: z.string(), questionCount: z.number() }),
  ),
  classrooms: z.array(ClassroomRef),
});
export type CourseDetail = z.infer<typeof CourseDetail>;
