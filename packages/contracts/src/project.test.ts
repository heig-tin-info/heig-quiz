import { describe, expect, it } from "vitest";

import { ProjectGradingScale, StudentProjectCard, defaultProjectGradingScale } from "./project.js";
import { GradeRow, ProjectGradeRow, StudentGrades } from "./results.js";
import { StudentActivityCard } from "./student.js";

const ID = "11111111-1111-4111-8111-111111111111";
const START = "2026-10-01T08:00:00.000Z";
const DEADLINE = "2026-10-15T22:00:00.000Z";

describe("ProjectGradingScale (D05, spec 06 no. 49)", () => {
  it("is linear by default, rounded to the nearest tenth", () => {
    expect(defaultProjectGradingScale()).toEqual({ kind: "linear", rounding: "nearest" });
  });

  it("offers the preset 'the score is the grade', and nothing else", () => {
    expect(ProjectGradingScale.parse({ kind: "score_is_grade" })).toEqual({ kind: "score_is_grade", rounding: "nearest" });
    expect(ProjectGradingScale.safeParse({ kind: "threshold" }).success).toBe(false);
  });
});

describe("the student's project card (F-PROJ-04)", () => {
  const card = {
    kind: "project",
    id: ID,
    title: "Lab 2",
    classroomId: ID,
    classroomName: "PRG1-2026",
    courseCode: "PRG1",
    startAt: START,
    deadlineAt: DEADLINE,
    status: "in_progress",
    repoFullName: "heig-prg1/lab2-alice",
  } as const;

  it("is a member of StudentActivityCard", () => {
    expect(StudentActivityCard.parse(card)).toEqual(card);
  });

  it("drops what the student view never carries (N-SEC-20)", () => {
    const parsed = StudentProjectCard.parse({ ...card, sourceFullName: "heig-prg1/lab2-source", teacherPoints: 5 });
    expect(Object.keys(parsed)).not.toContain("sourceFullName");
    expect(Object.keys(parsed)).not.toContain("teacherPoints");
  });
});

describe("the student's Grades: a project row (F-PROJ-14, product owner 2026-10-01)", () => {
  const row = {
    kind: "project",
    projectId: ID,
    title: "Lab 2",
    date: DEADLINE,
    status: "released",
    score: { points: 4.5, totalPoints: 6, grade: 4.5 },
  } as const;

  it("round-trips, in a classroom's group beside an evaluation's", () => {
    const evaluation = {
      kind: "evaluation",
      evaluationId: ID,
      title: "Test 1",
      mode: "exam",
      date: START,
      status: "released",
      feedbackAttemptId: null,
      score: { points: 12, totalPoints: 18, grade: 4.3 },
    } as const;
    const grades = [
      {
        classroom: { id: ID, name: "PRG1-2026", courseCode: "PRG1", courseName: "Programmation 1", period: "2026-A", archived: false },
        rows: [row, evaluation],
      },
    ];
    expect(StudentGrades.parse(grades)).toEqual(grades);
  });

  it("exists only released, with a grade", () => {
    expect(GradeRow.safeParse({ ...row, status: "available" }).success).toBe(false);
    expect(GradeRow.safeParse({ ...row, score: { points: 4.5, totalPoints: 6, grade: null } }).success).toBe(false);
    expect(GradeRow.safeParse({ ...row, score: null }).success).toBe(false);
  });

  it("carries neither the score's source, the teacher's comment nor the repository (N-SEC-20)", () => {
    expect(Object.keys(ProjectGradeRow.shape).sort()).toEqual(["date", "kind", "projectId", "score", "status", "title"]);
    expect(Object.keys(ProjectGradeRow.shape.score.shape).sort()).toEqual(["grade", "points", "totalPoints"]);
    const leaky = {
      ...row,
      source: "teacher",
      teacherComment: "See me",
      repoFullName: "heig-prg1/lab2-alice",
      score: { ...row.score, source: "review" },
    };
    const parsed = JSON.stringify(GradeRow.parse(leaky));
    for (const forbidden of ["source", "teacherComment", "See me", "repoFullName", "lab2-alice", "review"]) {
      expect(parsed).not.toContain(forbidden);
    }
  });
});
