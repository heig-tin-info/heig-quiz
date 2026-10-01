/**
 * The activities of every kind, where a page lists them together (ADR-035
 * §2). Each list is the concatenation of the kinds' own; the web app orders
 * and groups the rows itself (`activities/model.ts`).
 *
 * `KINDS` is a plain list, not a registry: a kind is added here by hand, in
 * the same pull request as its kind (the projects: M3-01, filled by M3-02).
 */
import type { ActivitySummary, StudentActivities, StudentClassroomPage } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
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

/** The Activities tab of the student's classroom page: every kind's groups, concatenated. */
async function studentCards(
  db: Db,
  caller: Caller,
  classroomId: string,
  now: Date,
): Promise<StudentActivities> {
  const kinds: StudentActivities[] = await Promise.all(
    KINDS.map((k) => k.studentCards(db, caller, classroomId, now)),
  );
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
 * Whether the Journal tab exists is the `journal` module's answer.
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
    hasJournal(db, scope.room.id),
  ]);
  return {
    classroom,
    activities,
    hasJournal: journal,
    hasProjects: false,
    serverNow: now.toISOString(),
  };
}
