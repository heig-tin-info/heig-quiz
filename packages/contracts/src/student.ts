/**
 * The student's classrooms (F-ORG-14, F-ORG-15, merge task M5-01): the
 * Courses list and the page of one classroom. Both are student payloads: what
 * a student with a claimed seat reads, and exactly what a teacher in the
 * student view (ADR-018) and an impersonation session (ADR-034) read too
 * (spec 05 §5.7). Nothing here carries a draft, another student's data or
 * another classroom's.
 */
import { z } from "zod";

import { EvaluationCard, StudentPollCard } from "./live.js";
import { StudentProjectCard } from "./project.js";

/** One card of the Courses list: a classroom where the caller holds a claimed seat. */
export const StudentClassroom = z.object({
  id: z.uuid(),
  name: z.string(),
  period: z.string(),
  courseName: z.string(),
  courseCode: z.string(),
  /** Teaching staff, for the student to know whom they are working with. */
  teachers: z.array(z.string()),
  /** The caller's own seat's bonus; 0 for a staff member without a seat. */
  timeBonusPercent: z.number().int(),
});
export type StudentClassroom = z.infer<typeof StudentClassroom>;

/**
 * An activity as the student's classroom page shows it, whatever its kind
 * (ADR-035 §2): a union on `kind`, like `ActivitySummary`. An evaluation's is
 * the student home's card, tagged.
 */
export const StudentActivityCard = z.discriminatedUnion("kind", [
  EvaluationCard.extend({ kind: z.literal("evaluation") }),
  StudentProjectCard,
]);
export type StudentActivityCard = z.infer<typeof StudentActivityCard>;

/**
 * The three groups of the Activities tab (F-ORG-15), sorted as the student
 * home sorts them: Open now is what the student can still do. `polls` are the
 * classroom's running polls (issue #163), never an activity card.
 */
export const StudentActivities = z.object({
  polls: z.array(StudentPollCard),
  open: z.array(StudentActivityCard),
  upcoming: z.array(StudentActivityCard),
  past: z.array(StudentActivityCard),
});
export type StudentActivities = z.infer<typeof StudentActivities>;

/** `GET /app/api/student/classrooms/:id`: the header, the activities, and which tabs exist. */
export const StudentClassroomPage = z.object({
  /** An archived classroom's page stays reachable by its address, as it is (F-ORG-15). */
  classroom: StudentClassroom.extend({ archived: z.boolean() }),
  activities: StudentActivities,
  /** The Journal tab (F-JRN-07): the classroom has a journal, whatever it shows this caller. */
  hasJournal: z.boolean(),
  /** The projects' tab; always false until the projects land (M3). */
  hasProjects: z.boolean(),
  serverNow: z.iso.datetime(),
});
export type StudentClassroomPage = z.infer<typeof StudentClassroomPage>;
