/**
 * The student's classrooms and home (F-ORG-14, F-ORG-15, merge tasks M5-01
 * and M3-09a): the Courses list, the page of one classroom, and the home,
 * which is the Activities of every classroom in one read. All are student
 * payloads: what a student with a claimed seat reads, and exactly what a
 * teacher in the student view (ADR-018) and an impersonation session
 * (ADR-034) read too (spec 05 §5.7). Nothing here carries a draft, another
 * student's data or another classroom's.
 */
import { z } from "zod";

import { StudentGroupSetCard } from "./group.js";
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
 * An activity as the student's pages show it, whatever its kind (ADR-035
 * §2): a union on `kind`, like `ActivitySummary`. An evaluation's is the
 * evaluation card, tagged; a project's is {@link StudentProjectCard}.
 */
export const StudentActivityCard = z.discriminatedUnion("kind", [
  EvaluationCard.extend({ kind: z.literal("evaluation") }),
  StudentProjectCard,
]);
export type StudentActivityCard = z.infer<typeof StudentActivityCard>;

/**
 * The three groups of the Activities (F-ORG-14, F-ORG-15), each kind
 * sorted as its module sorts it: Open now is what the student can still do;
 * Upcoming what is coming (a project before its start); Past what is over
 * (a project locked or released for them). `polls` are the running polls
 * (issue #163), never an activity card; `groupSets` the group sets open to
 * the student's self-formation (F-PROJ-22), drawn in Open now, never an
 * activity card either.
 */
export const StudentActivities = z.object({
  polls: z.array(StudentPollCard),
  groupSets: z.array(StudentGroupSetCard),
  open: z.array(StudentActivityCard),
  upcoming: z.array(StudentActivityCard),
  /**
   * Not drawn on the home any more (the Grades page has them, F-ORG-14), but
   * kept: the classroom page's Past group is this list narrowed to the
   * classroom, one rule for both.
   */
  past: z.array(StudentActivityCard),
});
export type StudentActivities = z.infer<typeof StudentActivities>;

/** `GET /app/api/student/home`: the Activities of every classroom the caller holds a seat in. */
export const StudentHome = StudentActivities.extend({ serverNow: z.iso.datetime() });
export type StudentHome = z.infer<typeof StudentHome>;

/**
 * `GET /app/api/student/classrooms/:id`: the header, the activities, and
 * which tabs exist. A project is listed in Activities like an evaluation
 * (F-ORG-15): there is no Projects tab.
 */
export const StudentClassroomPage = z.object({
  /** An archived classroom's page stays reachable by its address, as it is (F-ORG-15). */
  classroom: StudentClassroom.extend({ archived: z.boolean() }),
  activities: StudentActivities,
  /** The Journal tab (F-JRN-07): the classroom has a journal, whatever it shows this caller. */
  hasJournal: z.boolean(),
  /** The Groups tab (F-PROJ-22): a group set of the classroom reaches its students (`StudentGroupSet`). */
  hasGroups: z.boolean(),
  serverNow: z.iso.datetime(),
});
export type StudentClassroomPage = z.infer<typeof StudentClassroomPage>;
