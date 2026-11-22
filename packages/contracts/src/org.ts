/**
 * `org` route schemas (PLAN-MVP §4.1): courses, their staff and pools,
 * classrooms and the roster.
 *
 * This file used to be `classroom.ts`; the names are unchanged, so the web
 * app keeps importing them from the package root.
 */
import { z } from "zod";

import type { StudentWork as StudentWorkFacts } from "@quiz/domain";

import { CourseRole, PersonRef, teacherChoiceWith } from "./common.js";
import { ConceptRef } from "./concept.js";
import { ConditionKind, EvaluationCondition } from "./evaluation.js";
import { CoursePoolMode, PoolColor, PoolIcon } from "./pool.js";

/** One roster entry of one classroom: `/classrooms/:id/roster/:eid`. */
export const RosterEntryParams = z.object({ id: z.uuid(), eid: z.uuid() });
export type RosterEntryParams = z.infer<typeof RosterEntryParams>;

/** A course: the unit a staff, a pool and a set of classrooms hang off. */
export const CourseCreate = z.object({
  name: z.string().trim().min(1).max(200),
  /** Short school code (`PRG1`), trimmed and upper-cased here, on both sides. */
  code: z.string().trim().toUpperCase().min(1).max(32),
  /** The course's icon and its colour, picked as a pool's are; null is the default. */
  icon: PoolIcon.nullable().optional(),
  color: PoolColor.nullable().optional(),
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

/**
 * The refusals of the roster's writes, `{ error, message }`:
 *   - `duplicate_email` (409) — a PATCH to an address another line holds;
 *   - `already_enrolled` (409) — a self-enroll by a user enrolled under
 *     another address;
 *   - `student_line` (409) — a self-enroll that would turn the student
 *     line holding the caller's e-mail into their staff seat, and take its
 *     GitHub access away (ADR-018, ADR-077 §3): nothing was changed; sent
 *     again with `?convert=1` once the teacher confirmed;
 *   - `revoke_failed` (502) — GitHub refused to take the student's access
 *     to a project repository away before a removal, an unclaim, an e-mail
 *     change or a self-enroll that detaches their account (F-PROJ-17,
 *     ADR-070 §5): nothing was changed, retry. GitHub out of reach (the App
 *     gone, the repository deleted) is no refusal: there is nothing to take.
 */
export const ROSTER_REFUSALS = ["duplicate_email", "already_enrolled", "student_line", "revoke_failed"] as const;
export const RosterErrorCode = z.enum(ROSTER_REFUSALS);
export type RosterErrorCode = z.infer<typeof RosterErrorCode>;

/**
 * `GET /classrooms/:id/roster/candidates?q=` (ADR-133): a few letters of a
 * name or of a school address. Under three letters the answer is empty, and
 * so it is for a caller who may not search: they add by address.
 */
export const RosterCandidateQuery = z.object({ q: z.string().trim().max(100).default("") });
export type RosterCandidateQuery = z.infer<typeof RosterCandidateQuery>;

/**
 * A person of the caller's school the roster does not hold yet: the name and
 * the school address, nothing else — no account id, no picture, no sign-in.
 * The address is also the pick: `RosterLineAdd` sends it back, and the
 * server checks it again against the same filter.
 */
export const RosterCandidate = z.object({
  givenName: z.string(),
  familyName: z.string(),
  email: z.string(),
});
export type RosterCandidate = z.infer<typeof RosterCandidate>;

export const RosterCandidates = z.array(RosterCandidate);
export type RosterCandidates = z.infer<typeof RosterCandidates>;

/**
 * `POST /classrooms/:id/roster/line` (ADR-133): one student, by address.
 * `picked`: the address of a search result, whose name the server takes
 * from the account (`404 student_not_found` when it is no longer one, `403
 * student_search_unavailable` for a caller who may not search);
 * otherwise an address-only line, its name blank until the claim fills it.
 * Either way the line stays pending (F-ORG-05).
 */
export const RosterLineAdd = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  picked: z.boolean().default(false),
  /** Accommodation: extra time in percent of the nominal duration. */
  timeBonusPercent: z.number().int().min(0).max(300).default(0),
});
export type RosterLineAdd = z.infer<typeof RosterLineAdd>;

/**
 * `POST /classrooms/:id/self-enroll`: `convert=1` confirms that the student
 * line holding the caller's e-mail becomes their staff seat (`409
 * student_line` without it).
 */
export const SelfEnrollQuery = z.strictObject({ convert: z.literal("1").optional() });
export type SelfEnrollQuery = z.infer<typeof SelfEnrollQuery>;

/**
 * `PUT /courses/:id/pools` — the whole set of pools the course draws from,
 * each with the mode it is linked in. A link already there keeps its mode
 * unless the body asks for a stronger one; a pool named twice takes the
 * stronger (ADR-095).
 */
export const CoursePoolsPut = z.object({
  pools: z.array(z.object({ poolId: z.uuid(), mode: CoursePoolMode })).max(50),
});
export type CoursePoolsPut = z.infer<typeof CoursePoolsPut>;

const CourseRef = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string(),
});
type CourseRef = z.infer<typeof CourseRef>;

/**
 * `POST /courses/:id/staff`: the account picked among the candidates
 * (`userId`, a teacher or an admin), or named by an address the picker does
 * not list — one of the two, never both. An assistant unless said otherwise.
 */
export const StaffAdd = teacherChoiceWith({ role: CourseRole.default("assistant") });
export type StaffAdd = z.infer<typeof StaffAdd>;

/** `PATCH /courses/:id/staff/:uid`. */
export const StaffPatch = z.object({ role: CourseRole });
export type StaffPatch = z.infer<typeof StaffPatch>;

/** One seat of one course's staff: `/courses/:id/staff/:uid`. */
export const StaffParam = z.object({ id: z.uuid(), uid: z.uuid() });
export type StaffParam = z.infer<typeof StaffParam>;

const StaffMember = PersonRef.extend({ role: CourseRole });
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
    z.object({
      id: z.uuid(),
      name: z.string(),
      visibility: z.string(),
      questionCount: z.number(),
      mode: CoursePoolMode,
    }),
  ),
  classrooms: z.array(ClassroomRef),
  /** The concepts the course declares, by label (ADR-081 §8); staff only, like the rest of this response. */
  concepts: z.array(ConceptRef),
});
export type CourseDetail = z.infer<typeof CourseDetail>;

/**
 * The answer of `PUT /courses/:id/concepts` (and the `concepts` of `GET /courses/:id`): the concepts a course
 * declares (ADR-081 §8, F-ORG-12), labelled in the reader's language, by
 * label then id. Staff only: never part of a student payload.
 */
export const CourseConcepts = z.object({ concepts: z.array(ConceptRef) });
export type CourseConcepts = z.infer<typeof CourseConcepts>;

/**
 * `PUT /courses/:id/concepts` — the whole set (an owner's). A concept may be
 * `proposed`; a merged or unknown one is a 422 `concept_not_found`.
 */
export const CourseConceptsPut = z.object({ conceptIds: z.array(z.uuid()).max(200) });
export type CourseConceptsPut = z.infer<typeof CourseConceptsPut>;

// --- The course's catalog of conditions (ADR-079 §5, F-ORG-16) ---

/** One entry of a course's catalog: `/courses/:id/conditions/:cid`. */
export const CourseConditionParam = z.object({ id: z.uuid(), cid: z.uuid() });
export type CourseConditionParam = z.infer<typeof CourseConditionParam>;

/**
 * `POST /courses/:id/conditions`: a kind and a text, the same rules as an
 * evaluation's condition (`EvaluationCondition`), which an entry is copied
 * into.
 */
export const CourseConditionCreate = EvaluationCondition.pick({ kind: true, text: true });
export type CourseConditionCreate = z.infer<typeof CourseConditionCreate>;

/** `PATCH /courses/:id/conditions/:cid`: its kind, its text, or both. */
export const CourseConditionPatch = CourseConditionCreate.partial().refine(
  (b) => Object.keys(b).length > 0,
  { message: "Nothing to update" },
);
export type CourseConditionPatch = z.infer<typeof CourseConditionPatch>;

/**
 * `PUT /courses/:id/conditions/order`: the ids of the ACTIVE entries, in
 * their new order — all of them, each once (`409 stale_order` otherwise).
 */
export const CourseConditionOrder = z.object({
  ids: z.array(z.uuid()).min(1).max(1000),
});
export type CourseConditionOrder = z.infer<typeof CourseConditionOrder>;

/**
 * One entry, as the staff reads it (`GET /courses/:id/conditions` lists them
 * all, the active ones first). Never part of a student payload.
 */
export const CourseCondition = z.object({
  id: z.uuid(),
  kind: ConditionKind,
  text: z.string(),
  archivedAt: z.string().nullable(),
});
export type CourseCondition = z.infer<typeof CourseCondition>;

// ---------------------------------------------------------- deleting what holds students' work (ADR-141)

/** What blocks a deletion, by kind and how many (`studentWorkOf`, `@quiz/domain`): never a name. */
export const StudentWork = z.object({
  classrooms: z.number().int().nonnegative(),
  evaluations: z.number().int().nonnegative(),
  projects: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  gradedRepos: z.number().int().nonnegative(),
  marks: z.number().int().nonnegative(),
  released: z.number().int().nonnegative(),
}) satisfies z.ZodType<StudentWorkFacts>;
export type StudentWork = z.infer<typeof StudentWork>;

/** The code of the refusal, the same for a course, a classroom, an evaluation and a project. */
export const HOLDS_STUDENT_WORK = "holds_student_work";

/**
 * The `409 holds_student_work` of `DELETE /courses/:id`, `/classrooms/:id`,
 * `/evaluations/:id` and `/projects/:id` (ADR-141): the entity holds a real
 * student's work or grades, so no role deletes it. The web app words it from
 * `work` and offers the archive where the entity has one.
 */
export const StudentWorkRefusal = z.object({
  error: z.literal(HOLDS_STUDENT_WORK),
  message: z.string(),
  work: StudentWork,
});
export type StudentWorkRefusal = z.infer<typeof StudentWorkRefusal>;

