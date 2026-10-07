import { describe, expect, it } from "vitest";

import {
  BranchName,
  PROJECT_DEFAULTS,
  ProjectCreate,
  ProjectGradingScale,
  ProjectPatch,
  ProtectedPath,
  StudentProject,
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
    invitation: "pending",
    githubLinked: true,
    repoFullName: "heig-prg1/lab2-alice",
    repoUrl: "https://github.com/heig-prg1/lab2-alice",
    // M3-14i: the state of the work, as the view reads it.
    work: { lastCommit: { sha: "a".repeat(40), at: START }, commits: 4, ciStatus: "pass", score: null },
  } as const;

  it("is a member of StudentActivityCard", () => {
    expect(StudentActivityCard.parse(card)).toEqual(card);
  });

  it("drops what the student view never carries (N-SEC-20)", () => {
    const parsed = StudentProjectCard.parse({ ...card, sourceFullName: "heig-prg1/lab2-source", teacherPoints: 5 });
    expect(Object.keys(parsed)).not.toContain("sourceFullName");
    expect(Object.keys(parsed)).not.toContain("teacherPoints");
  });

  it("is the base of the student's project view, which carries the repository and the release instead (M3-09a)", () => {
    const { invitation, repoFullName, repoUrl, work, ...facts } = card;
    void invitation;
    void work;
    const view = {
      ...facts,
      seat: "student",
      gradingMode: "auto",
      repo: {
        fullName: repoFullName,
        url: repoUrl,
        invitation: "accepted",
        deleted: false,
        locked: false,
        lastCommit: { sha: "a".repeat(40), at: START },
        commits: 4,
        ciStatus: "pass",
        run: { sha: "a".repeat(40), url: `${repoUrl}/actions/runs/7`, conclusion: "success", completedAt: START },
        score: { points: 7, max: 10, grade: { grade: 4.5, fellBack: false }, frozen: false },
      },
      release: null,
      workspace: null,
      serverNow: START,
    };
    expect(StudentProject.parse(view)).toEqual(view);
    // The staff's flags and the other slots have no field to land in.
    expect(StudentProject.safeParse({ ...view, repo: { ...view.repo, toVerify: true } }).success).toBe(true);
    expect(Object.keys(StudentProject.parse({ ...view, repo: { ...view.repo, toVerify: true } }).repo!)).not.toContain("toVerify");
    // Nobody invited (an `online_seb` project, ADR-047 §2): null, never a made-up "pending".
    expect(StudentProject.parse({ ...view, repo: { ...view.repo, invitation: null } }).repo!.invitation).toBeNull();
    expect(StudentProject.safeParse({ ...view, repo: { ...view.repo, invitation: "none" } }).success).toBe(false);
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
      score: { points: 12, totalPoints: 18, grade: 4.3, pendingCount: 0 },
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

describe("ProjectCreate and ProjectPatch (F-PROJ-01, F-PROJ-03, M3-02)", () => {
  const LAB = { name: "Lab 1", sourceRepo: "lab", deadlineAt: DEADLINE };

  it("fills the defaults defined once with the columns'", () => {
    expect(ProjectCreate.parse(LAB)).toEqual({
      ...LAB,
      publishMode: PROJECT_DEFAULTS.publishMode,
      graceMinutes: PROJECT_DEFAULTS.graceMinutes,
      sourceStrategy: PROJECT_DEFAULTS.sourceStrategy,
      deadlineStrategy: PROJECT_DEFAULTS.deadlineStrategy,
      gradingMode: PROJECT_DEFAULTS.gradingMode,
      protectedFiles: [],
      groupMode: false,
    });
    expect(PROJECT_DEFAULTS).toEqual({ graceMinutes: 30, sourceStrategy: "squash", deadlineStrategy: "lock", gradingMode: "auto", publishMode: "manual" });
  });

  it("asks a manual publication for a deadline or a duration, a scheduled one for both dates", () => {
    expect(ProjectCreate.safeParse({ ...LAB, deadlineAt: undefined, durationMinutes: 90 }).success).toBe(true);
    expect(ProjectCreate.safeParse({ ...LAB, durationMinutes: 90 }).success).toBe(false);
    expect(ProjectCreate.safeParse({ ...LAB, deadlineAt: undefined }).success).toBe(false);
    expect(ProjectCreate.safeParse({ ...LAB, startAt: START }).success).toBe(false);
    expect(ProjectCreate.safeParse({ ...LAB, publishMode: "scheduled", startAt: START }).success).toBe(true);
    expect(ProjectCreate.safeParse({ ...LAB, publishMode: "scheduled" }).success).toBe(false);
    expect(ProjectCreate.safeParse({ ...LAB, publishMode: "scheduled", startAt: DEADLINE }).success).toBe(false);
  });

  it("is strict, and has no work mode (F-PROJ-19)", () => {
    expect(ProjectCreate.safeParse({ ...LAB, workMode: "free" }).success).toBe(false);
    expect(ProjectPatch.safeParse({ sourceRepo: "other" }).success).toBe(false);
    expect(ProjectPatch.safeParse({ branches: ["main"] }).success).toBe(false);
    expect(ProjectPatch.safeParse({ sourceStrategy: "whole" }).success).toBe(false);
    expect(ProjectPatch.safeParse({}).success).toBe(false);
    expect(ProjectPatch.safeParse({ durationMinutes: null }).success).toBe(true);
  });

  it("names a group set only in group mode, and has no group size of its own (ADR-070)", () => {
    expect(ProjectCreate.safeParse({ ...LAB, groupMode: true, groupSetId: ID }).success).toBe(true);
    expect(ProjectCreate.safeParse({ ...LAB, groupSetId: ID }).success).toBe(false);
    expect(ProjectCreate.safeParse({ ...LAB, groupMode: true, groupSetId: "x" }).success).toBe(false);
    expect(ProjectCreate.safeParse({ ...LAB, groupMode: true, groupMaxSize: 3 }).success).toBe(false);
    expect(ProjectPatch.safeParse({ groupSetId: null }).success).toBe(true);
    expect(ProjectPatch.safeParse({ groupMaxSize: 3 }).success).toBe(false);
  });

  it("takes a repository name, branches and protected files that cannot leave their place", () => {
    for (const sourceRepo of ["../x", "org/x", ".", "..", "a b", ""]) {
      expect(ProjectCreate.safeParse({ ...LAB, sourceRepo }).success, sourceRepo).toBe(false);
    }
    for (const branch of ["-x", "a..b", "a/", "/a", ".hidden", "a.lock", "a//b", "a b"]) {
      expect(BranchName.safeParse(branch).success, branch).toBe(false);
    }
    expect(BranchName.safeParse("feature/lab-2.1").success).toBe(true);
    for (const path of ["/etc/passwd", "../x", "a/../b", "a\\b", "a//b", "./a"]) {
      expect(ProtectedPath.safeParse(path).success, path).toBe(false);
    }
    expect(ProtectedPath.safeParse(".github/workflows/grading.yml").success).toBe(true);
    expect(ProjectCreate.safeParse({ ...LAB, name: "!!!" }).success).toBe(false);
  });
});
