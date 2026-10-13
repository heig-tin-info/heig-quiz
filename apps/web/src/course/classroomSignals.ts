/*
 * What is happening in a classroom, for the second line of its row (#805):
 * the course's Classrooms tab and `/classrooms` show the whole set, the home
 * course card the live count only (`compact` on the row). Pure: the
 * activities are the caller's `GET /activities`, the journal and the
 * headcounts come with the room (`ClassroomSummary`), the instant is the
 * caller's. A signal that does not apply is absent or zero here, and the row
 * draws nothing for it.
 */
import type { ActivitySummary, ClassroomJournalSignal, ClassroomSummary } from "@quiz/contracts";

import { awaitsStaff, isLive, nextEventOf, type NextEvent } from "../activities/model";

export interface ClassroomSignals {
  /** The instant they were read at, which the row's relative dates count from. */
  now: number;
  /**
   * What is live, by the Activities page's own rule (`isLive`): students in
   * the room. A project is never live; an open one shows by its deadline.
   */
  live: number;
  /** What waits on the staff (`awaitsStaff`). */
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

export function classroomSignals(
  activities: readonly ActivitySummary[],
  room: Pick<ClassroomSummary, "id" | "students" | "claimed" | "journal">,
  now: number,
): ClassroomSignals {
  const rows = activities.filter((a) => a.classroom?.id === room.id);
  return {
    now,
    live: rows.filter((a) => isLive(a, now)).length,
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
