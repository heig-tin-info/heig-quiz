/**
 * 5c. The projects (F-PROJ-01, F-PROJ-03; M3-10): a classroom's projects as
 * the staff's lists read them (`ProjectActivitySummary`), checked by
 * `contract.test.ts`. `GET /classrooms/:id/projects` is served here; the
 * Activities section's rows are added by `poll.ts`, which serves
 * `GET /activities`, through {@link projectActivities}.
 *
 * Scene flag `?projects=1`: PRG1-2026 (`r1`, connected to GitHub in
 * `github.ts`) has three projects, one per state — a draft starting next
 * week, a published one due next week, one locked at last week's deadline.
 * Without it no classroom has one, so the default scenes are what they were.
 * The other classrooms are not connected: "New ▾ › Project" there leads to
 * the Settings' connect sheet.
 */
import type { ProjectActivitySummary } from "@quiz/contracts";

import { courses, rooms } from "./org";
import { D, flags, iso, MockError, on, role } from "./runtime";

/** The projects of `r1` under `?projects=1`: ids a human can type, as the mock's rule goes. */
const PROJECTS: { id: string; title: string; state: ProjectActivitySummary["state"]; start: number; deadline: number }[] =
  [
    { id: "pj-draft", title: "Labo 3 — listes chaînées", state: "draft", start: 7 * D, deadline: 21 * D },
    { id: "pj-published", title: "Labo 2 — pointeurs", state: "published", start: -7 * D, deadline: 7 * D },
    { id: "pj-locked", title: "Labo 1 — premiers pas en C", state: "locked", start: -35 * D, deadline: -7 * D },
  ];

/** Every project the staff persona's lists show: none without `?projects=1`. */
export function projectActivities(): ProjectActivitySummary[] {
  const room = rooms.find((r) => r.id === "r1");
  if (!flags.projects || !room || room.archivedAt !== null) return [];
  const course = courses.find((c) => c.id === room.courseId);
  return PROJECTS.map((p) => ({
    kind: "project",
    id: p.id,
    title: p.title,
    state: p.state,
    classroom: { id: room.id, name: room.name, courseCode: course?.code ?? "" },
    startAt: iso(p.start),
    deadlineAt: iso(p.deadline),
  }));
}

/** A classroom's projects, for its staff; anyone else reads the 404 of a missing classroom. */
on("GET", "/app/api/classrooms/:id/projects", (m) => {
  const id = m.groups!.id!;
  if (role === "student" || !rooms.some((r) => r.id === id)) throw new MockError(404, "Not found");
  return projectActivities().filter((p) => p.classroom.id === id);
});
