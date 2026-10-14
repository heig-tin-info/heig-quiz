import { describe, expect, it } from "vitest";

import type { EvaluationActivitySummary, ProjectActivitySummary } from "@quiz/contracts";

import { classroomSignals } from "./classroomSignals";

const ROOM = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const NOW = Date.parse("2026-10-13T10:00:00.000Z");
const HOUR = 3_600_000;
const at = (h: number) => new Date(NOW + h * HOUR).toISOString();

const classroom = (id = ROOM) => ({ id, name: "PRG1-2026", courseCode: "PRG1" });

let n = 0;
function evaluation(over: Partial<EvaluationActivitySummary> = {}): EvaluationActivitySummary {
  n += 1;
  return {
    kind: "evaluation",
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    title: `E${n}`,
    mode: "exam",
    state: "draft",
    classroom: classroom(),
    takeHome: false,
    clock: "live",
    opensAt: null,
    closesAt: null,
    startedAt: null,
    closedAt: null,
    closedBy: null,
    updatedAt: at(-1),
    ...over,
  };
}

function project(over: Partial<ProjectActivitySummary> = {}): ProjectActivitySummary {
  n += 1;
  return {
    kind: "project",
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    title: `P${n}`,
    state: "published",
    phase: "published",
    classroom: classroom(),
    startAt: at(-24 * 7),
    deadlineAt: at(24 * 7),
    source: { fullName: "heig/lab-source" },
    distribution: { fullName: "heig/lab-squashed" },
    participantCount: 0,
    ...over,
  };
}

const room = { id: ROOM, students: 24, claimed: 24, journal: null };

describe("classroomSignals (#805)", () => {
  it("is all zeros and nulls for a quiet classroom: the row draws nothing", () => {
    expect(classroomSignals([], room, NOW)).toEqual({
      now: NOW,
      live: 0,
      toGrade: 0,
      next: null,
      journal: null,
      enrollment: null,
      evaluations: 0,
      projects: 0,
    });
  });

  it("reads only the classroom's own activities", () => {
    const s = classroomSignals(
      [evaluation({ state: "running", classroom: classroom(OTHER) }), evaluation({ classroom: null })],
      room,
      NOW,
    );
    expect(s.live).toBe(0);
    expect(s.evaluations).toBe(0);
  });

  it("counts as live what the Activities page does: an evaluation in the room, never a take-home nor a project", () => {
    const s = classroomSignals(
      [
        evaluation({ state: "running" }),
        evaluation({ state: "lobby" }),
        evaluation({ mode: "exercise", state: "running", takeHome: true }),
        project(),
        project({ state: "draft", phase: "draft" }),
      ],
      room,
      NOW,
    );
    expect(s.live).toBe(2);
  });

  it("counts to grade: grading, a closed exam, a graded project — not a closed exercise nor a poll", () => {
    const s = classroomSignals(
      [
        evaluation({ state: "grading" }),
        evaluation({ state: "closed" }),
        evaluation({ state: "released" }),
        evaluation({ mode: "exercise", state: "closed" }),
        evaluation({ mode: "poll", state: "closed" }),
        project({ state: "locked", phase: "graded" }),
        project({ state: "locked", phase: "released" }),
        project({ state: "locked", phase: "locked" }),
      ],
      room,
      NOW,
    );
    expect(s.toGrade).toBe(3);
  });

  it("names the next opening or deadline, the soonest ahead", () => {
    const soon = evaluation({ state: "scheduled", opensAt: at(5), title: "Quiz 2" });
    const s = classroomSignals(
      [evaluation({ state: "scheduled", opensAt: at(48) }), soon, project({ deadlineAt: at(30) })],
      room,
      NOW,
    );
    expect(s.next).toMatchObject({ row: { title: "Quiz 2" }, at: at(5), what: "opens" });
    const due = classroomSignals([project({ title: "Lab 1", deadlineAt: at(2) })], room, NOW);
    expect(due.next).toMatchObject({ row: { title: "Lab 1" }, what: "closes" });
    expect(classroomSignals([project({ deadlineAt: at(-2) })], room, NOW).next).toBeNull();
  });

  it("shows the enrollment only while some seats are unclaimed", () => {
    expect(classroomSignals([], { ...room, claimed: 18 }, NOW).enrollment).toEqual({ claimed: 18, students: 24 });
    expect(classroomSignals([], room, NOW).enrollment).toBeNull();
    expect(classroomSignals([], { ...room, students: 0, claimed: 0 }, NOW).enrollment).toBeNull();
  });

  it("counts the evaluations and the projects, and passes the journal through", () => {
    const journal = { lastPage: { title: "Week 2", at: at(-48) }, nextPage: null };
    const s = classroomSignals([evaluation(), evaluation({ mode: "poll" }), project()], { ...room, journal }, NOW);
    expect([s.evaluations, s.projects]).toEqual([2, 1]);
    expect(s.journal).toBe(journal);
  });
});
