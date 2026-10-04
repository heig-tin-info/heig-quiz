import { describe, expect, it } from "vitest";

import { studentProjectGroup, studentProjectStatus, studentScoreRun } from "./projectStudent.js";

const at = (iso: string) => new Date(iso);
const base = {
  startAt: at("2026-10-01T08:00:00Z"),
  deadlineAt: at("2026-10-09T22:00:00Z"),
  released: false,
  accepted: false,
  locked: false,
};
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
