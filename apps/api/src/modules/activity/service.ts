/**
 * The activities of every kind, where a page lists them together (ADR-035
 * §2). Each list is the concatenation of the kinds' own; the web app orders
 * and groups the rows itself (`activities/model.ts`).
 *
 * `KINDS` is a plain list, not a registry: a kind is added here by hand, in
 * the same pull request as its module (the projects, M3-02).
 */
import { eq } from "drizzle-orm";

import type { ActivitySummary, StudentActivities, StudentClassroomPage } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { classroomJournals } from "../../db/schema.js";
import type { Caller, ReadableClassroom } from "../guards.js";
import { studentClassroomHeader } from "../org/service.js";
import { evaluationActivity } from "./evaluation.js";

const KINDS = [evaluationActivity] as const;

/** `GET /activities`: what the caller manages in their own name, every kind. */
export async function listForTeacher(db: Db, caller: Caller, now: Date): Promise<ActivitySummary[]> {
  return (await Promise.all(KINDS.map((k) => k.listForTeacher(db, caller, now)))).flat();
}

/** The Activities tab of the student's classroom page: every kind's groups, concatenated. */
async function studentCards(
  db: Db,
  caller: Caller,
  classroomId: string,
  now: Date,
): Promise<StudentActivities> {
  const kinds = await Promise.all(KINDS.map((k) => k.studentCards(db, caller, classroomId, now)));
  return {
    polls: kinds.flatMap((k) => k.polls),
    open: kinds.flatMap((k) => k.open),
    upcoming: kinds.flatMap((k) => k.upcoming),
    past: kinds.flatMap((k) => k.past),
  };
}

/**
 * `GET /student/classrooms/:id` (F-ORG-15): the student payload of a
 * classroom `scope` loaded through `readableClassroom`, whoever the caller
 * is — a student, a teacher in the student view, an impersonation session.
 * The journal's row is the `journal` module's; it is only read here, for
 * whether the tab exists.
 */
export async function studentClassroomPage(
  db: Db,
  caller: Caller,
  scope: ReadableClassroom,
  now: Date,
): Promise<StudentClassroomPage> {
  const [classroom, activities, journal] = await Promise.all([
    studentClassroomHeader(db, scope),
    studentCards(db, caller, scope.room.id, now),
    db
      .select({ id: classroomJournals.classroomId })
      .from(classroomJournals)
      .where(eq(classroomJournals.classroomId, scope.room.id))
      .limit(1),
  ]);
  return {
    classroom,
    activities,
    hasJournal: journal.length > 0,
    hasProjects: false,
    serverNow: now.toISOString(),
  };
}
