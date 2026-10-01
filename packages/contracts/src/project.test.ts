import { describe, expect, it } from "vitest";

import {
  ProjectCreate,
  ProjectGradingScale,
  ProjectPatch,
  ReviewCheckpointCreate,
  ScoreOverride,
  ScoreRunList,
  StudentProjectCard,
  defaultProjectGradingScale,
} from "./project.js";
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

describe("ProjectCreate (F-PROJ-01)", () => {
  const base = { name: "Lab 2", sourceRepo: "lab2-source" };

  it("fills heig-classroom's defaults for a manual project with a duration", () => {
    expect(ProjectCreate.parse({ ...base, durationMinutes: 60 * 24 * 14 })).toEqual({
      ...base,
      durationMinutes: 60 * 24 * 14,
      publishMode: "manual",
      graceMinutes: 30,
      sourceStrategy: "squash",
      deadlineStrategy: "lock",
      gradingMode: "auto",
      protectedFiles: [],
      groupMode: false,
    });
  });

  it("wants a deadline date or a duration, exactly one, when manual", () => {
    expect(ProjectCreate.safeParse(base).success).toBe(false);
    expect(ProjectCreate.safeParse({ ...base, deadlineAt: DEADLINE, durationMinutes: 60 }).success).toBe(false);
    expect(ProjectCreate.safeParse({ ...base, deadlineAt: DEADLINE }).success).toBe(true);
  });

  it("wants both dates, in order, and no duration, when scheduled", () => {
    const scheduled = { ...base, publishMode: "scheduled" };
    expect(ProjectCreate.safeParse({ ...scheduled, startAt: START }).success).toBe(false);
    expect(ProjectCreate.safeParse({ ...scheduled, startAt: DEADLINE, deadlineAt: START }).success).toBe(false);
    expect(ProjectCreate.safeParse({ ...scheduled, startAt: START, deadlineAt: DEADLINE, durationMinutes: 60 }).success).toBe(false);
    expect(ProjectCreate.safeParse({ ...scheduled, startAt: START, deadlineAt: DEADLINE }).success).toBe(true);
  });

  it("refuses a field it does not know (no work mode: a project is free, D09)", () => {
    expect(ProjectCreate.safeParse({ ...base, deadlineAt: DEADLINE, workMode: "online" }).success).toBe(false);
  });
});

describe("the staff's other writes", () => {
  it("refuses an empty patch", () => {
    expect(ProjectPatch.safeParse({}).success).toBe(false);
    expect(ProjectPatch.parse({ deadlineAt: DEADLINE })).toEqual({ deadlineAt: DEADLINE });
  });

  it("takes a checkpoint by date or by offset before the deadline, exactly one", () => {
    expect(ReviewCheckpointCreate.safeParse({ name: "mid-term", offsetDays: -3 }).success).toBe(true);
    expect(ReviewCheckpointCreate.safeParse({ name: "mid-term", dueAt: START }).success).toBe(true);
    expect(ReviewCheckpointCreate.safeParse({ name: "mid-term" }).success).toBe(false);
    expect(ReviewCheckpointCreate.safeParse({ name: "mid-term", dueAt: START, offsetDays: -3 }).success).toBe(false);
    expect(ReviewCheckpointCreate.safeParse({ name: "mid-term", offsetDays: 0 }).success).toBe(false);
    expect(ReviewCheckpointCreate.safeParse({ name: "Mid term", offsetDays: -3 }).success).toBe(false);
  });

  it("sets or clears a teacher score", () => {
    expect(ScoreOverride.parse({ points: 5.5, comment: "Good" })).toEqual({ points: 5.5, comment: "Good" });
    expect(ScoreOverride.parse({ points: null })).toEqual({ points: null });
    expect(ScoreOverride.safeParse({ points: -1 }).success).toBe(false);
  });

  it("round-trips a repository's runs", () => {
    const list = {
      currentRunId: ID,
      frozenRunId: null,
      reviewRunId: null,
      runs: [
        {
          id: ID,
          workflowRunId: 987654321,
          runAttempt: 1,
          points: 4.5,
          max: 6,
          testsPassed: 9,
          testsTotal: 10,
          parseStatus: "ok",
          conclusion: "success",
          sha: "a".repeat(40),
          branch: "main",
          kind: "ci",
          afterDeadline: false,
          completedAt: START,
        },
      ],
    };
    expect(ScoreRunList.parse(list)).toEqual(list);
    expect(ScoreRunList.safeParse({ ...list, runs: [{ ...list.runs[0], kind: "llm" }] }).success).toBe(false);
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
    score: { points: 4.5, max: 6, grade: 4.5 },
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
    expect(GradeRow.safeParse({ ...row, score: { points: 4.5, max: 6, grade: null } }).success).toBe(false);
    expect(GradeRow.safeParse({ ...row, score: null }).success).toBe(false);
  });

  it("carries neither the score's source, the teacher's comment nor the repository (N-SEC-20)", () => {
    expect(Object.keys(ProjectGradeRow.shape).sort()).toEqual(["date", "kind", "projectId", "score", "status", "title"]);
    expect(Object.keys(ProjectGradeRow.shape.score.shape).sort()).toEqual(["grade", "max", "points"]);
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
