/**
 * The activities of every kind, where a page lists them together (ADR-035
 * §2). Each list is the concatenation of the kinds' own; the web app orders
 * and groups the rows itself (`activities/model.ts`).
 *
 * `KINDS` is a plain list, not a registry: a kind is added here by hand, in
 * the same pull request as its kind (the projects: M3-01, filled by M3-02).
 */
import { and, countDistinct, eq, inArray } from "drizzle-orm";

import type {
  ActivityStats,
  ActivitySummary,
  StudentActivities,
  StudentClassroomPage,
  StudentHome,
} from "@quiz/contracts";
import { activityBucket } from "@quiz/domain";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { enrollments } from "../../db/schema.js";
import type { Caller, ReadableClassroom } from "../guards.js";
import { hasJournal } from "../journal/service.js";
import { studentClassroomHeader } from "../org/service.js";
import { evaluationActivity } from "./evaluation.js";
import { projectActivity } from "./project.js";

const KINDS = [evaluationActivity, projectActivity] as const;

/** `GET /activities`: what the caller manages in their own name, every kind. */
export async function listForTeacher(db: Db, caller: Caller, now: Date): Promise<ActivitySummary[]> {
  return (await Promise.all(KINDS.map((k) => k.listForTeacher(db, caller, now)))).flat();
}

/**
 * `GET /activities/stats`: the students of what is open, each once. The
 * classrooms come from the caller's own list, so the scope is the kinds'
 * access predicates and nothing new (invariant 6); "open" is
 * `activityBucket`, the page's own rule. A student is an enrollment that is
 * not a staff seat, known by its email (claimed or not), so one enrolled in
 * two of those classrooms counts once.
 */
export async function statsForTeacher(db: Db, caller: Caller, now: Date): Promise<ActivityStats> {
  const open = new Set(
    (await listForTeacher(db, caller, now))
      .filter((a) => activityBucket(a.state) === "open" && a.classroom !== null)
      .map((a) => a.classroom!.id),
  );
  if (open.size === 0) return { studentsInProgress: 0 };
  const [row] = await db
    .select({ n: countDistinct(enrollments.email) })
    .from(enrollments)
    .where(and(inArray(enrollments.classroomId, [...open]), eq(enrollments.staff, false)));
  return { studentsInProgress: row?.n ?? 0 };
}

/** The student's Activities, every classroom or one: every kind's groups, concatenated. */
async function studentCards(
  db: Db,
  caller: Caller,
  now: Date,
  classroomId?: string,
): Promise<StudentActivities> {
  const kinds: StudentActivities[] = await Promise.all(
    KINDS.map((k) => k.studentCards(db, caller, now, classroomId)),
  );
  return {
    polls: kinds.flatMap((k) => k.polls),
    open: kinds.flatMap((k) => k.open),
    upcoming: kinds.flatMap((k) => k.upcoming),
    past: kinds.flatMap((k) => k.past),
  };
}

/**
 * `GET /student/home` (F-ORG-14): the Activities of every classroom the
 * caller holds a claimed seat in, every kind — the summary of what is open
 * now and what is coming. The student payload whoever asks: a student, a
 * teacher through their staff seat (ADR-018), an impersonation session.
 */
export async function studentHome(db: Db, caller: Caller, now: Date): Promise<StudentHome> {
  return { ...(await studentCards(db, caller, now)), serverNow: iso(now) };
}

/**
 * `GET /student/classrooms/:id` (F-ORG-15): the student payload of a
 * classroom `scope` loaded through `readableClassroom`, whoever the caller
 * is — a student, a teacher in the student view, an impersonation session.
 * Whether the Journal tab exists is the `journal` module's answer; a
 * project is listed in Activities like an evaluation, never in a tab of its
 * own.
 */
export async function studentClassroomPage(
  db: Db,
  caller: Caller,
  scope: ReadableClassroom,
  now: Date,
): Promise<StudentClassroomPage> {
  const [classroom, activities, journal] = await Promise.all([
    studentClassroomHeader(db, scope),
    studentCards(db, caller, now, scope.room.id),
    hasJournal(db, scope.room.id),
  ]);
  return {
    classroom,
    activities,
    hasJournal: journal,
    serverNow: iso(now),
  };
}
