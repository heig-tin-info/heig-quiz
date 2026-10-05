import { useQuery } from "@tanstack/react-query";

import type { ActivitySummary, StudentHome } from "@quiz/contracts";

import { api } from "./api";
import { activitiesKey, studentHomeKey } from "./queryKeys";

/*
 * Where the command palette finds the projects to list (M7-01). No project
 * list of its own: the staff's Activities and the student's home already
 * carry them, on keys their pages share, so the palette costs one request at
 * most and a student's palette only ever reads student endpoints (the rows
 * are the caller's own classrooms', filtered by the server).
 */

export interface PaletteProject {
  id: string;
  title: string;
  /** Where it lives, for the second line and the fuzzy match. */
  hint: string;
}

/** The staff's projects out of `GET /activities`, archived ones already left out by the server. */
export function staffProjects(rows: readonly ActivitySummary[]): PaletteProject[] {
  return rows.flatMap((row) =>
    row.kind === "project"
      ? [{ id: row.id, title: row.title, hint: `${row.classroom.courseCode} — ${row.classroom.name}` }]
      : [],
  );
}

/** A student's projects out of `GET /student/home`, whichever group they sit in. */
export function studentProjects(home: StudentHome): PaletteProject[] {
  return [...home.open, ...home.upcoming, ...home.past].flatMap((card) =>
    card.kind === "project"
      ? [{ id: card.id, title: card.title, hint: `${card.courseCode} — ${card.classroomName}` }]
      : [],
  );
}

/** Read only while the palette is open, and only the endpoint of the viewer's UI. */
export function usePaletteProjects(teacherUi: boolean, enabled: boolean): PaletteProject[] {
  const staff = useQuery<ActivitySummary[]>({
    queryKey: activitiesKey,
    queryFn: () => api("/app/api/activities"),
    enabled: enabled && teacherUi,
  });
  const student = useQuery<StudentHome>({
    queryKey: studentHomeKey,
    queryFn: () => api("/app/api/student/home"),
    enabled: enabled && !teacherUi,
  });
  if (teacherUi) return staffProjects(staff.data ?? []);
  return student.data ? studentProjects(student.data) : [];
}
