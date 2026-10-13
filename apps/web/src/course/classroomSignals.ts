/*
 * What is happening in a classroom, for the second line of its row (#805):
 * the course's Classrooms tab and `/classrooms` show the whole set, the home
 * course card the live count only. Pure: the activities are the caller's
 * `GET /activities`, the journal and the headcounts come with the room
 * (`ClassroomSummary`), the instant is the caller's. A signal that does not
 * apply is absent or zero here, and the row draws nothing for it.
 */
import type { ActivitySummary, ClassroomJournalSignal, ClassroomSummary } from "@quiz/contracts";

import { isLive, nextEventOf, type NextEvent } from "../activities/model";

export interface ClassroomSignals {
  /** Students in the room now (`isLiveNow`), or a project open to them. */
  live: number;
  /**
   * What waits on the staff (ADR-104's amber): an evaluation in `grading`,
   * an exam `closed` but not `released`, a project `graded` but not
   * released. A closed exercise or poll is not counted: it asks nothing.
   */
  toGrade: number;
  /** The next opening or closing of the classroom's activities, if any. */
  next: NextEvent | null;
  /** Its journal's last visible page and next scheduled one; null without a journal. */
  journal: ClassroomJournalSignal | null;
  /** Claimed seats out of the students, only while some are not claimed. */
  enrollment: { claimed: number; students: number } | null;
  evaluations: number;
  projects: number;
}

/** Whether an activity is live on a classroom row: the deploy guard's rule, or a project open to the students. */
const liveOnRow = (a: ActivitySummary, now: number): boolean =>
  isLive(a, now) || (a.kind === "project" && a.state === "published");

/** Whether it waits for the staff's correction or release (owner's answer to #805, question 1). */
export function awaitsStaff(a: ActivitySummary): boolean {
  if (a.kind === "project") return a.phase === "graded";
  return a.state === "grading" || (a.mode === "exam" && a.state === "closed");
}

export function classroomSignals(
  activities: readonly ActivitySummary[],
  room: Pick<ClassroomSummary, "id" | "students" | "claimed" | "journal">,
  now: number,
): ClassroomSignals {
  const rows = activities.filter((a) => a.classroom?.id === room.id);
  return {
    live: rows.filter((a) => liveOnRow(a, now)).length,
    toGrade: rows.filter(awaitsStaff).length,
    next: nextEventOf(rows, now),
    journal: room.journal,
    enrollment:
      room.students > 0 && room.claimed < room.students
        ? { claimed: room.claimed, students: room.students }
        : null,
    evaluations: rows.filter((a) => a.kind === "evaluation").length,
    projects: rows.filter((a) => a.kind === "project").length,
  };
}

/** The home card's reading (#805): the live count alone, the rest left to the course page. */
export const liveOnly = (s: ClassroomSignals | undefined): ClassroomSignals | undefined =>
  s && { live: s.live, toGrade: 0, next: null, journal: null, enrollment: null, evaluations: 0, projects: 0 };
