import { describe, expect, it } from "vitest";

import { commitAttribution, studentCiReading, studentCommitCount, studentProjectGroup, studentProjectStatus, studentScoreRun } from "./projectStudent.js";

const at = (iso: string) => new Date(iso);
const base = {
  startAt: at("2026-10-01T08:00:00Z"),
  deadlineAt: at("2026-10-09T22:00:00Z"),
  released: false,
  accepted: false,
  locked: false,
  deadlineStrategy: "lock" as const,
};
const commit = { ...base, deadlineStrategy: "commit" as const };
const during = at("2026-10-05T12:00:00Z");

describe("studentProjectStatus (F-PROJ-04)", () => {
  it("is to accept until the repository exists, in progress after", () => {
    expect(studentProjectStatus(base, during)).toBe("to_accept");
    expect(studentProjectStatus({ ...base, accepted: true }, during)).toBe("in_progress");
  });

  it("is to accept before the start too: the start tells the card it cannot be accepted yet", () => {
    expect(studentProjectStatus(base, at("2026-09-30T08:00:00Z"))).toBe("to_accept");
  });

  it("is locked at the effective deadline, accepted or not, and while GitHub holds the repository", () => {
    expect(studentProjectStatus({ ...base, accepted: true }, base.deadlineAt)).toBe("locked");
    expect(studentProjectStatus(base, at("2026-10-20T00:00:00Z"))).toBe("locked");
    expect(studentProjectStatus({ ...base, accepted: true, locked: true }, during)).toBe("locked");
  });

  it("is released once the scores are out, whatever else", () => {
    expect(studentProjectStatus({ ...base, released: true }, during)).toBe("released");
    expect(studentProjectStatus({ ...base, released: true, locked: true }, at("2026-11-01T00:00:00Z"))).toBe("released");
  });

  it("says the deadline passed under the commit strategy, whose repository stays open (#958)", () => {
    expect(studentProjectStatus({ ...commit, accepted: true }, during)).toBe("in_progress");
    expect(studentProjectStatus(commit, during)).toBe("to_accept");
    expect(studentProjectStatus({ ...commit, accepted: true }, commit.deadlineAt)).toBe("deadline_passed");
    expect(studentProjectStatus(commit, at("2026-10-20T00:00:00Z"))).toBe("deadline_passed");
    expect(studentProjectStatus({ ...commit, released: true }, at("2026-10-20T00:00:00Z"))).toBe("released");
  });

  it("is locked under the commit strategy while GitHub holds the repository (the staff's hand), before or after the deadline", () => {
    expect(studentProjectStatus({ ...commit, accepted: true, locked: true }, during)).toBe("locked");
    expect(studentProjectStatus({ ...commit, accepted: true, locked: true }, at("2026-10-20T00:00:00Z"))).toBe("locked");
  });
});

describe("studentProjectGroup (F-ORG-15)", () => {
  it("is upcoming before the start, open while it runs, past once locked or released", () => {
    expect(studentProjectGroup(base, at("2026-09-30T08:00:00Z"))).toBe("upcoming");
    expect(studentProjectGroup(base, base.startAt)).toBe("open");
    expect(studentProjectGroup({ ...base, accepted: true }, during)).toBe("open");
    expect(studentProjectGroup({ ...base, accepted: true, locked: true }, during)).toBe("past");
    expect(studentProjectGroup(base, base.deadlineAt)).toBe("past");
    expect(studentProjectGroup({ ...base, released: true }, during)).toBe("past");
  });

  it("puts a commit project past its deadline in past, though its repository stays open (#958)", () => {
    expect(studentProjectGroup({ ...commit, accepted: true }, during)).toBe("open");
    expect(studentProjectGroup({ ...commit, accepted: true }, commit.deadlineAt)).toBe("past");
  });
});

describe("studentScoreRun (F-PROJ-15, N-SEC-20)", () => {
  it("reads the current run before the deadline is applied", () => {
    expect(studentScoreRun({ deadlineAppliedAt: null, current: "c", frozen: null })).toEqual({ run: "c", frozen: false });
    expect(studentScoreRun({ deadlineAppliedAt: null, current: null, frozen: null })).toBeNull();
  });

  it("reads the frozen run once it is, and never the current one after the deadline", () => {
    const applied = at("2026-10-09T22:00:00Z");
    expect(studentScoreRun({ deadlineAppliedAt: applied, current: "late", frozen: "f" })).toEqual({ run: "f", frozen: true });
    expect(studentScoreRun({ deadlineAppliedAt: applied, current: "late", frozen: null })).toBeNull();
  });
});

describe("studentCiReading (F-PROJ-15, N-SEC-20)", () => {
  const deadline = at("2026-10-09T22:00:00Z");
  const stored = { deadlineAppliedAt: null, lastCommitSha: "head", lastCommitAt: at("2026-10-05T10:00:00Z"), ciStatus: "pending" as const };
  const run = { headSha: "selected", conclusion: "success" };

  it("reads the stored head and CI state before the deadline", () => {
    expect(studentCiReading(stored, run, deadline, during)).toEqual({ lastCommit: { sha: "head", at: stored.lastCommitAt }, ciStatus: "pending" });
    expect(studentCiReading({ ...stored, lastCommitSha: null }, null, deadline, during)).toEqual({ lastCommit: null, ciStatus: "pending" });
  });

  it("stands on the selected run once the deadline is over: passed on the clock, or applied by the ticker", () => {
    const passed = { lastCommit: { sha: "selected", at: null }, ciStatus: "pass" };
    expect(studentCiReading(stored, run, deadline, deadline)).toEqual(passed);
    expect(studentCiReading({ ...stored, deadlineAppliedAt: deadline }, run, deadline, during)).toEqual(passed);
  });

  it("reads every conclusion but success as fail, and nothing without a selected run", () => {
    for (const conclusion of ["failure", "cancelled", "skipped", "timed_out"]) {
      expect(studentCiReading(stored, { ...run, conclusion }, deadline, deadline).ciStatus).toBe("fail");
    }
    expect(studentCiReading(stored, null, deadline, deadline)).toEqual({ lastCommit: null, ciStatus: "none" });
  });
});

describe("studentCommitCount (M3-14i, N-SEC-20)", () => {
  it("sums the commits of the pushes received by the deadline, an old receipt counting one", () => {
    const receipts = [
      { receivedAt: at("2026-10-02T10:00:00Z"), commits: 3 },
      { receivedAt: at("2026-10-03T10:00:00Z"), commits: null },
      { receivedAt: at("2026-10-04T10:00:00Z"), commits: 0 },
      { receivedAt: base.deadlineAt, commits: 2 },
      { receivedAt: at("2026-10-09T22:00:01Z"), commits: 5 },
    ];
    expect(studentCommitCount(receipts, base.deadlineAt)).toBe(6);
    expect(studentCommitCount([], base.deadlineAt)).toBe(0);
  });
});

describe("commitAttribution (ADR-136)", () => {
  const ALICE = 101;
  const BOB = 102;
  const STAFF = 900;
  const members = new Map<string, number | null>([
    ["alice", ALICE],
    ["bob", BOB],
    ["carol", null],
  ]);
  // The week of Monday 5 October 2026 (Zurich); the deadline is Friday 9 October, 22:00 UTC.
  const receipts = [
    // Before the authors were recorded: all unattributed, one for a receipt without a count.
    { receivedAt: at("2026-09-29T10:00:00Z"), commits: 2, authors: null },
    { receivedAt: at("2026-09-30T10:00:00Z"), commits: null, authors: null },
    // Alice 3, Bob 1, a staff member 1, an author with no linked account 1.
    { receivedAt: at("2026-10-05T10:00:00Z"), commits: 6, authors: [{ id: ALICE, n: 3 }, { id: BOB, n: 1 }, { id: STAFF, n: 1 }] },
    // Sunday 23:30 UTC is Monday in Zurich: still the same week as the deadline's.
    { receivedAt: at("2026-10-04T22:30:00Z"), commits: 1, authors: [{ id: BOB, n: 1 }] },
    { receivedAt: base.deadlineAt, commits: 2, authors: [{ id: BOB, n: 2 }] },
    // After the deadline: never counted, by anyone.
    { receivedAt: at("2026-10-09T22:00:01Z"), commits: 4, authors: [{ id: ALICE, n: 4 }] },
  ];

  it("counts each member's commits by the week of the receipt, the rest unattributed, the deadline's rule", () => {
    const got = commitAttribution(receipts, base.deadlineAt, members);
    expect(got.members.get("alice")).toEqual({ n: 3, weeks: [{ weekStart: "2026-10-05", n: 3 }] });
    expect(got.members.get("bob")).toEqual({ n: 4, weeks: [{ weekStart: "2026-10-05", n: 4 }] });
    expect(got.members.get("carol")).toEqual({ n: 0, weeks: [] });
    // Two pre-rollout pushes (2 + 1) the week before, then the staff's and the unknown author's commits.
    expect(got.unattributed).toEqual({ n: 5, weeks: [{ weekStart: "2026-09-28", n: 3 }, { weekStart: "2026-10-05", n: 2 }] });
    expect(got.total).toBe(studentCommitCount(receipts, base.deadlineAt));
    expect(got.total).toBe(3 + 4 + 5);
  });

  it("is all zeros with no receipt", () => {
    expect(commitAttribution([], base.deadlineAt, members)).toMatchObject({ total: 0, unattributed: { n: 0, weeks: [] } });
  });
});
