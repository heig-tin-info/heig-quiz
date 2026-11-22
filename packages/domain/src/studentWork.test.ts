import { describe, expect, it } from "vitest";

import { evaluationHoldsStudentWork, projectHoldsStudentWork, studentWorkOf } from "./studentWork.js";

const exam = { classroomId: "a", mode: "exam" as const, released: false, attemptsWithWork: 0, scoreMarks: 0 };
const project = { classroomId: "a", released: false, gradedRepos: 0, scoreMarks: 0 };

describe("evaluationHoldsStudentWork", () => {
  it("holds work once a student's attempt holds any, a score is in the gradebook, or once released", () => {
    expect(evaluationHoldsStudentWork(exam)).toBe(false);
    expect(evaluationHoldsStudentWork({ ...exam, attemptsWithWork: 1 })).toBe(true);
    expect(evaluationHoldsStudentWork({ ...exam, scoreMarks: 1 })).toBe(true);
    expect(evaluationHoldsStudentWork({ ...exam, mode: "exercise", released: true })).toBe(true);
  });

  it("never for a poll, whatever it holds", () => {
    expect(evaluationHoldsStudentWork({ ...exam, mode: "poll", released: true, attemptsWithWork: 40, scoreMarks: 1 })).toBe(false);
  });
});

describe("projectHoldsStudentWork", () => {
  it("holds work once a repository is graded, a score is in the gradebook, or once released", () => {
    expect(projectHoldsStudentWork(project)).toBe(false);
    expect(projectHoldsStudentWork({ ...project, gradedRepos: 2 })).toBe(true);
    expect(projectHoldsStudentWork({ ...project, scoreMarks: 1 })).toBe(true);
    expect(projectHoldsStudentWork({ ...project, released: true })).toBe(true);
  });
});

describe("studentWorkOf", () => {
  it("is null when nothing blocks", () => {
    expect(studentWorkOf({ evaluations: [exam, { ...exam, mode: "poll", released: true }], projects: [project] })).toBeNull();
  });

  it("sums the blocking activities by kind, their marks and their classrooms", () => {
    expect(
      studentWorkOf({
        evaluations: [
          { ...exam, attemptsWithWork: 3 },
          { ...exam, classroomId: "b", mode: "exercise", released: true, attemptsWithWork: 2, scoreMarks: 1 },
          exam,
        ],
        projects: [{ ...project, gradedRepos: 4, scoreMarks: 2 }, project],
      }),
    ).toEqual({ classrooms: 2, evaluations: 2, projects: 1, attempts: 5, gradedRepos: 4, marks: 3, released: 1 });
  });
});
