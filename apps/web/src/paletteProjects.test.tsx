import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ActivitySummary, StudentHome, StudentProjectCard } from "@quiz/contracts";

import { staffProjects, studentProjects, usePaletteProjects } from "./paletteProjects";
import { mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * Where the palette's projects come from (M7-01): the staff's Activities, a
 * student's home — and never the other's endpoint.
 */

const NOW = "2026-10-05T08:00:00.000Z";
const card = (id: string, title: string, classroomName: string): StudentProjectCard => ({
  kind: "project",
  seat: "student",
  groupMode: false,
  id,
  title,
  classroomId: `room-${id}`,
  classroomName,
  courseCode: "PRG1",
  startAt: NOW,
  deadlineAt: NOW,
  status: "in_progress",
  invitation: null,
  githubLinked: true,
  repoFullName: null,
  repoUrl: null,
});

const home = (over: Partial<StudentHome> = {}): StudentHome => ({
  polls: [],
  groupSets: [],
  open: [card("p1", "Labo 1", "PRG1-A")],
  upcoming: [card("p2", "Labo 2", "PRG1-A")],
  past: [card("p3", "Labo 0", "PRG1-A")],
  serverNow: NOW,
  ...over,
});

const staffRows = [
  {
    kind: "project",
    id: "s1",
    title: "Labo staff",
    state: "published",
    classroom: { id: "r1", name: "PRG1-B", courseCode: "PRG1" },
    startAt: NOW,
    deadlineAt: NOW,
  },
  { kind: "evaluation", id: "e1", title: "Exam" },
] as unknown as ActivitySummary[];

describe("the mappers", () => {
  it("keeps the staff's projects only, with where they live", () => {
    expect(staffProjects(staffRows)).toEqual([{ id: "s1", title: "Labo staff", hint: "PRG1 — PRG1-B" }]);
  });

  it("finds a student's projects in every group of their home, evaluations left out", () => {
    const withExam = home({ open: [...home().open, { kind: "evaluation", id: "e1" } as never] });
    expect(studentProjects(withExam).map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  });
});

function Probe({ teacherUi, enabled = true }: { teacherUi: boolean; enabled?: boolean }) {
  const projects = usePaletteProjects(teacherUi, enabled);
  return (
    <ul>
      {projects.map((p) => (
        <li key={p.id}>{p.title}</li>
      ))}
    </ul>
  );
}

describe("usePaletteProjects", () => {
  it("reads the student's home, never the staff's Activities, for a student", async () => {
    const { calls } = mockFetch({ "GET /app/api/student/home": ok(home()) });
    renderWithProviders(<Probe teacherUi={false} />);
    expect(await screen.findByText("Labo 1")).toBeInTheDocument();
    expect(calls.map((c) => c.url)).toEqual(["/app/api/student/home"]);
  });

  it("reads the Activities, never the student's home, for the teacher UI", async () => {
    const { calls } = mockFetch({ "GET /app/api/activities": ok(staffRows) });
    renderWithProviders(<Probe teacherUi />);
    expect(await screen.findByText("Labo staff")).toBeInTheDocument();
    expect(calls.map((c) => c.url)).toEqual(["/app/api/activities"]);
  });

  it("reads nothing while the palette is closed", () => {
    const { calls } = mockFetch({});
    renderWithProviders(<Probe teacherUi={false} enabled={false} />);
    expect(calls).toEqual([]);
  });
});
