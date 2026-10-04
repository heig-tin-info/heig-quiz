/**
 * `org` route schemas (PLAN-MVP §4.1): courses, their staff and pools,
 * classrooms and the roster.
 *
 * This file used to be `classroom.ts`; the names are unchanged, so the web
 * app keeps importing them from the package root.
 */
import { z } from "zod";

/** One roster entry of one classroom: `/classrooms/:id/roster/:eid`. */
export const RosterEntryParams = z.object({ id: z.uuid(), eid: z.uuid() });
export type RosterEntryParams = z.infer<typeof RosterEntryParams>;

/** A course: the unit a staff, a pool and a set of classrooms hang off. */
export const CourseCreate = z.object({
  name: z.string().trim().min(1).max(200),
  /** Short school code (`PRG1`), trimmed and upper-cased here, on both sides. */
  code: z.string().trim().toUpperCase().min(1).max(32),
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
    name: z.string().trim().min(1).max(200),
    period: z.string().max(64).default(""),
    periodStart: periodMonths.periodStart.default(null),
    periodEnd: periodMonths.periodEnd.default(null),
  })
  .superRefine(checkPeriodMonths);
export type ClassroomCreate = z.infer<typeof ClassroomCreate>;

export const ClassroomPatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    period: z.string().max(64).optional(),
    /** The two months travel together: a patch sets both or neither. */
    periodStart: periodMonths.periodStart.optional(),
    periodEnd: periodMonths.periodEnd.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" })
  .refine((b) => (b.periodStart === undefined) === (b.periodEnd === undefined), {
    message: "Set both months of the period together",
    path: ["periodEnd"],
  })
  .superRefine(checkPeriodMonths);
export type ClassroomPatch = z.infer<typeof ClassroomPatch>;

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

/**
 * What a seat on a course's staff may do (ADR-068): an `owner` runs the
 * course — its staff, its pools, its classrooms, the release of results —
 * and an `assistant` does the day-to-day work in it.
 */
export const CourseRole = z.enum(["owner", "assistant"]);
export type CourseRole = z.infer<typeof CourseRole>;

/** `POST /courses/:id/staff`: an account named by an address, an assistant unless said otherwise. */
export const StaffAdd = z.object({
  email: z.email(),
  role: CourseRole.default("assistant"),
});
export type StaffAdd = z.infer<typeof StaffAdd>;

/** `PATCH /courses/:id/staff/:uid`. */
export const StaffPatch = z.object({ role: CourseRole });
export type StaffPatch = z.infer<typeof StaffPatch>;

/** One seat of one course's staff: `/courses/:id/staff/:uid`. */
export const StaffParam = z.object({ id: z.uuid(), uid: z.uuid() });
export type StaffParam = z.infer<typeof StaffParam>;

const StaffMember = z.object({
  userId: z.uuid(),
  givenName: z.string(),
  familyName: z.string(),
  email: z.string(),
  role: CourseRole,
});
type StaffMember = z.infer<typeof StaffMember>;

const ClassroomRef = z.object({
  id: z.uuid(),
  name: z.string(),
  period: z.string(),
  ...periodMonths,
  archivedAt: z.string().nullable(),
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
