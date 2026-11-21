import { describe, expect, it } from "vitest";

import { evaluationHoldsStudentWork, projectHoldsStudentWork, studentWorkOf } from "./studentWork.js";

const exam = { classroomId: "a", mode: "exam" as const, released: false, startedStudentAttempts: 0 };
const project = { classroomId: "a", released: false, gradedRepos: 0 };

describe("evaluationHoldsStudentWork", () => {
  it("holds work once a student started, or once released", () => {
    expect(evaluationHoldsStudentWork(exam)).toBe(false);
    expect(evaluationHoldsStudentWork({ ...exam, startedStudentAttempts: 1 })).toBe(true);
    expect(evaluationHoldsStudentWork({ ...exam, mode: "exercise", released: true })).toBe(true);
  });

  it("never for a poll, whatever it holds", () => {
    expect(evaluationHoldsStudentWork({ ...exam, mode: "poll", released: true, startedStudentAttempts: 40 })).toBe(false);
  });
});

describe("projectHoldsStudentWork", () => {
  it("holds work once a repository is graded, or once released", () => {
    expect(projectHoldsStudentWork(project)).toBe(false);
    expect(projectHoldsStudentWork({ ...project, gradedRepos: 2 })).toBe(true);
    expect(projectHoldsStudentWork({ ...project, released: true })).toBe(true);
  });
});

describe("studentWorkOf", () => {
  it("is null when nothing blocks", () => {
    expect(studentWorkOf({ evaluations: [exam, { ...exam, mode: "poll", released: true }], projects: [project] })).toBeNull();
  });

  it("sums the blocking activities by kind, and their classrooms", () => {
    expect(
      studentWorkOf({
        evaluations: [
          { ...exam, startedStudentAttempts: 3 },
          { ...exam, classroomId: "b", mode: "exercise", released: true, startedStudentAttempts: 2 },
          exam,
        ],
        projects: [{ ...project, gradedRepos: 4 }, project],
      }),
    ).toEqual({ classrooms: 2, evaluations: 2, projects: 1, attempts: 5, gradedRepos: 4, released: 1 });
  });
});
