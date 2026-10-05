import { describe, expect, it } from "vitest";

import type { ProjectRepoView } from "@quiz/contracts";

import { makeProject, makeRepo, PAST, row } from "../test/project-fixtures";
import { projectNotices } from "./projectNotices";

/*
 * F-PROJ-21 (M3-09c): the staff's notices, computed from two reads of the
 * project page — each kind from its own difference, counted per kind and
 * never per repository; nothing from an unchanged read.
 */

const detail = (...repos: (ProjectRepoView | null)[]) =>
  makeProject({ rows: repos.map((repo, i) => row(i + 1, repo)) });

const pushed = (repo: ProjectRepoView, n: number): ProjectRepoView => ({
  ...repo,
  lastCommit: { sha: `${n}`.repeat(40).slice(0, 40), at: PAST },
});
const scored = (repo: ProjectRepoView, runId: string, points = 9): ProjectRepoView => ({
  ...repo,
  scores: { ...repo.scores, current: { runId, points, max: 10, grade: null } },
});
const asked = (repo: ProjectRepoView): ProjectRepoView => ({
  ...repo,
  review: { status: "asked", reason: null, askedAt: PAST, sha: repo.lastCommit!.sha, runId: null },
});

describe("projectNotices", () => {
  it("notices nothing on an unchanged read, however many repositories it has", () => {
    const p = detail(makeRepo(1), makeRepo(2), null);
    expect(projectNotices(p, p)).toEqual([]);
    expect(projectNotices(p, detail(makeRepo(1), makeRepo(2), null))).toEqual([]);
  });

  it("counts an acceptance for each repository the previous read did not have, and no push for its commits", () => {
    const before = detail(makeRepo(1), null, null);
    const after = detail(makeRepo(1), makeRepo(2), makeRepo(3));
    expect(projectNotices(before, after)).toEqual([{ kind: "accepted", count: 2 }]);
  });

  it("counts the pushes: a repository whose last commit changed, or got its first", () => {
    const silent = makeRepo(3);
    const before = detail(makeRepo(1), makeRepo(2, { lastCommit: null }), silent);
    const after = detail(pushed(makeRepo(1), 7), pushed(makeRepo(2), 8), silent);
    expect(projectNotices(before, after)).toEqual([{ kind: "pushed", count: 2 }]);
  });

  it("counts a score captured when the current score comes from another run — not when the frozen slot fills", () => {
    const r1 = makeRepo(1);
    const r2 = makeRepo(2);
    const frozen = { ...r2, frozenAt: PAST, scores: { ...r2.scores, frozen: r2.scores.current } };
    expect(projectNotices(detail(r1, r2), detail(scored(r1, "run-3"), frozen))).toEqual([{ kind: "scored", count: 1 }]);
    // The first score of a repository counts too.
    const unscored = makeRepo(1, { scores: { ...r1.scores, current: null } });
    expect(projectNotices(detail(unscored), detail(scored(r1, "run-1")))).toEqual([{ kind: "scored", count: 1 }]);
  });

  it("counts the final reviews asked since", () => {
    const before = detail(makeRepo(1), makeRepo(2));
    const after = detail(asked(makeRepo(1)), asked(makeRepo(2)));
    expect(projectNotices(before, after)).toEqual([{ kind: "reviewAsked", count: 2 }]);
    // Asked already: nothing more to say.
    expect(projectNotices(after, after)).toEqual([]);
  });

  it("says several kinds at once, each with its own count, in one order", () => {
    const before = detail(makeRepo(1), makeRepo(2), null);
    const after = detail(pushed(scored(makeRepo(1), "run-3"), 7), asked(makeRepo(2)), makeRepo(3));
    expect(projectNotices(before, after)).toEqual([
      { kind: "accepted", count: 1 },
      { kind: "pushed", count: 1 },
      { kind: "scored", count: 1 },
      { kind: "reviewAsked", count: 1 },
    ]);
  });

  it("ignores a repository that disappeared, and the deadline, the lock and the flags", () => {
    const r1 = makeRepo(1);
    const before = detail(r1, makeRepo(2));
    const locked = { ...r1, locked: true, deadlineAppliedAt: PAST, flags: { ...r1.flags, protectionSuspended: true } };
    expect(projectNotices(before, detail(locked))).toEqual([]);
  });

  it("echoes no staff write of the page: the teacher's score, a release, a protection re-enabled", () => {
    const r1 = makeRepo(1, { frozenAt: PAST, review: { status: "asked", reason: null, askedAt: PAST, sha: "a", runId: null } });
    const before = detail(r1);
    const graded = { ...r1, scores: { ...r1.scores, teacher: { points: 7, max: 10, comment: null, gradedAt: PAST } } };
    expect(projectNotices(before, detail(graded))).toEqual([]);
    const released = { ...r1, released: { points: 8, max: 10 } };
    expect(projectNotices(before, detail(released))).toEqual([]);
    // Re-enabled: the review is pending again; the job's later ask is the notice.
    const pending = { ...r1, review: { status: "pending" as const, reason: null, askedAt: null, sha: null, runId: null } };
    expect(projectNotices(before, detail(pending))).toEqual([]);
    expect(projectNotices(detail(pending), detail(r1))).toEqual([{ kind: "reviewAsked", count: 1 }]);
  });
});
