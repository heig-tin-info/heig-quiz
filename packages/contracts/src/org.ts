/**
 * `org` route schemas (PLAN-MVP §4.1): courses, their staff and pools,
 * classrooms, the join code and the roster.
 *
 * This file used to be `classroom.ts`; the names are unchanged, so the web
 * app keeps importing them from the package root.
 */
import { z } from "zod";

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

/**
 * A month, `YYYY-MM` — the value of an `<input type="month">`, and the one
 * place its shape is checked. Two of them compare as strings in calendar
 * order, which is what the checks below use.
 */
export const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM");

/**
 * The dated period of a classroom (F-ORG-03): its first and last month,
 * both or neither, the last not before the first. `null` = no dates, the
 * classroom is always current. `period` beside it stays a free label.
 */
const periodMonths = {
  periodStart: YearMonth.nullable(),
  periodEnd: YearMonth.nullable(),
};

/**
 * Both months or neither, end ≥ start — the same rule as the DB check. Exported
 * for the MCP tool, whose input spreads `ClassroomCreate.shape` and so loses
 * the refinement.
 */
export function checkPeriodMonths(
  b: { periodStart?: string | null | undefined; periodEnd?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  const start = b.periodStart ?? null;
  const end = b.periodEnd ?? null;
  if ((start === null) !== (end === null)) {
    ctx.addIssue({
      code: "custom",
      path: [start === null ? "periodStart" : "periodEnd"],
      message: "Give both months of the period, or neither",
    });
  } else if (start !== null && end !== null && end < start) {
    ctx.addIssue({
      code: "custom",
      path: ["periodEnd"],
      message: "The period ends before it starts",
    });
  }
}

export const ClassroomCreate = z
  .object({
    name: z.string().min(1).max(200),
    period: z.string().max(64).default(""),
    periodStart: periodMonths.periodStart.default(null),
    periodEnd: periodMonths.periodEnd.default(null),
  })
  .superRefine(checkPeriodMonths);
export type ClassroomCreate = z.infer<typeof ClassroomCreate>;

export const ClassroomPatch = z
  .object({
    name: z.string().min(1).max(200).optional(),
    period: z.string().max(64).optional(),
    /** The two months travel together: a patch sets both or neither. */
    periodStart: periodMonths.periodStart.optional(),
    periodEnd: periodMonths.periodEnd.optional(),
    /**
     * Self-enrolment switch (F-ORG-06). Turning it on mints a join code if
     * the classroom has none; turning it off keeps the code but refuses it.
     */
    joinCodeEnabled: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" })
  .refine((b) => (b.periodStart === undefined) === (b.periodEnd === undefined), {
    message: "Set both months of the period together",
    path: ["periodEnd"],
  })
  .superRefine(checkPeriodMonths);
export type ClassroomPatch = z.infer<typeof ClassroomPatch>;

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

const CourseRef = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string(),
});
type CourseRef = z.infer<typeof CourseRef>;

const StaffMember = z.object({
  userId: z.uuid(),
  givenName: z.string(),
  familyName: z.string(),
  email: z.string(),
});
type StaffMember = z.infer<typeof StaffMember>;

const ClassroomRef = z.object({
  id: z.uuid(),
  name: z.string(),
  period: z.string(),
  ...periodMonths,
  archivedAt: z.string().nullable(),
  joinCode: z.string().nullable(),
  joinCodeEnabled: z.boolean(),
});
type ClassroomRef = z.infer<typeof ClassroomRef>;

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
