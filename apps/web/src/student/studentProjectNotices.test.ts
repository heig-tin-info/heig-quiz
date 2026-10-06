import { describe, expect, it } from "vitest";

import type { StudentProject, StudentProjectRepo } from "@quiz/contracts";

import { studentProjectNotices } from "./studentProjectNotices";

/*
 * F-PROJ-21, N-SEC-20 (M3-09c): the student's notices, computed from two
 * reads of their project — each kind from its own difference in THEIR
 * repository's fields; nothing from an unchanged read, nothing after the
 * deadline but the lock itself, and the frozen flag alone is not a score.
 */

const NOW = Date.parse("2026-10-05T10:00:00.000Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW + days * DAY).toISOString();
const SHA = "9a3f1c7e2b4d6f8a0c1e3b5d7f9a1c3e5b7d9f1a";
const SHA2 = "1c3e5b7d9f1a9a3f1c7e2b4d6f8a0c1e3b5d7f9a";

const repo = (over: Partial<StudentProjectRepo> = {}): StudentProjectRepo => ({
  fullName: "heig/labo-1-lea",
  url: "https://github.com/heig/labo-1-lea",
  invitation: "accepted",
  deleted: false,
  locked: false,
  lastCommit: { sha: SHA, at: at(-0.1) },
  ciStatus: "pass",
  run: { sha: SHA, url: "https://github.com/heig/labo-1-lea/actions/runs/42", conclusion: "success", completedAt: at(-0.1) },
  score: { points: 34, max: 40, grade: { grade: 5.3, fellBack: false }, frozen: false },
  ...over,
});

const project = (over: Partial<StudentProject> = {}): StudentProject => ({
  kind: "project",
  seat: "student",
  id: "p1",
  title: "Labo 1 — Pointeurs",
  classroomId: "r1",
  classroomName: "PRG1-2026",
  courseCode: "PRG1",
  startAt: at(-3),
  deadlineAt: at(6),
  status: "in_progress",
  githubLinked: true,
  gradingMode: "auto",
  repo: repo(),
  release: null,
  serverNow: at(0),
  ...over,
});

describe("studentProjectNotices", () => {
  it("notices nothing on an unchanged read", () => {
    const p = project();
    expect(studentProjectNotices(p, p)).toEqual([]);
    expect(studentProjectNotices(p, project({ serverNow: at(0.01) }))).toEqual([]);
  });

  it("notices a push: the last commit changed while the project is open", () => {
    const after = project({ repo: repo({ lastCommit: { sha: SHA2, at: at(0) } }) });
    expect(studentProjectNotices(project(), after)).toEqual(["pushed"]);
    // The first commit of a repository counts too.
    expect(studentProjectNotices(project({ repo: repo({ lastCommit: null }) }), project())).toEqual(["pushed"]);
  });

  it("notices a score that appears or changes — not the indicative score becoming the frozen one", () => {
    const none = project({ repo: repo({ score: null }) });
    expect(studentProjectNotices(none, project())).toEqual(["scored"]);
    const better = project({ repo: repo({ score: { points: 36, max: 40, grade: null, frozen: false } }) });
    expect(studentProjectNotices(project(), better)).toEqual(["scored"]);
    const frozen = project({ repo: repo({ score: { points: 34, max: 40, grade: { grade: 5.3, fellBack: false }, frozen: true } }) });
    expect(studentProjectNotices(project(), frozen)).toEqual([]);
  });

  it("notices the deadline applied, and nothing else of that read: the commit shown is then the evaluated one", () => {
    const locked = project({
      status: "locked",
      repo: repo({ locked: true, lastCommit: { sha: SHA2, at: at(-1) }, score: { points: 30, max: 40, grade: null, frozen: true } }),
    });
    expect(studentProjectNotices(project(), locked)).toEqual(["locked"]);
    // Locked already: no push, no score, whatever the view's commit becomes.
    const later = project({ ...locked, repo: repo({ ...locked.repo!, lastCommit: { sha: SHA, at: at(-2) }, score: null }) });
    expect(studentProjectNotices(locked, later)).toEqual([]);
  });

  it("compares no push nor score once the deadline has passed on the server's clock, even unlocked yet", () => {
    const passed = { deadlineAt: at(-0.01), serverNow: at(0) };
    const before = project(passed);
    const after = project({ ...passed, repo: repo({ lastCommit: { sha: SHA2, at: at(0) }, score: { points: 40, max: 40, grade: null, frozen: false } }) });
    expect(studentProjectNotices(before, after)).toEqual([]);
  });

  it("notices the invitation accepted", () => {
    const pending = project({ repo: repo({ invitation: "pending", lastCommit: null, run: null, score: null, ciStatus: "none" }) });
    const accepted = project({ repo: repo({ lastCommit: null, run: null, score: null, ciStatus: "none" }) });
    expect(studentProjectNotices(pending, accepted)).toEqual(["accepted"]);
  });

  it("says nothing of a repository appearing, deleted, or gone", () => {
    const none = project({ status: "to_accept", repo: null });
    expect(studentProjectNotices(none, project())).toEqual([]);
    const deleted = project({ repo: repo({ deleted: true }) });
    expect(studentProjectNotices(project(), deleted)).toEqual([]);
    expect(studentProjectNotices(deleted, project({ repo: repo({ deleted: true, lastCommit: { sha: SHA2, at: at(0) } }) }))).toEqual([]);
    expect(studentProjectNotices(project(), none)).toEqual([]);
  });

  it("says nothing of a release: the bell does", () => {
    const released = project({
      status: "released",
      release: { at: at(0), points: 34, max: 40, grade: null, comment: null },
      repo: repo({ locked: true, score: { points: 34, max: 40, grade: null, frozen: true } }),
    });
    const lockedBefore = project({ status: "locked", repo: released.repo });
    expect(studentProjectNotices(lockedBefore, released)).toEqual([]);
  });
});
