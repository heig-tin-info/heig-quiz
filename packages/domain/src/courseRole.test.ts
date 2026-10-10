import { describe, expect, it } from "vitest";

import {
  courseRoleAllows,
  effectiveCourseRole,
  evaluationDeletionRole,
  evaluationGradingRole,
  staffChangeRefusal,
} from "./courseRole.js";

describe("effectiveCourseRole", () => {
  it("makes an owner of an admin with Super Powers, seat or none", () => {
    expect(effectiveCourseRole({ reachesAll: true, seatRole: null })).toBe("owner");
    expect(effectiveCourseRole({ reachesAll: true, seatRole: "assistant" })).toBe("owner");
  });

  it("otherwise gives the seat's role, and nothing without a seat", () => {
    expect(effectiveCourseRole({ reachesAll: false, seatRole: "owner" })).toBe("owner");
    expect(effectiveCourseRole({ reachesAll: false, seatRole: "assistant" })).toBe("assistant");
    expect(effectiveCourseRole({ reachesAll: false, seatRole: null })).toBeNull();
  });
});

describe("courseRoleAllows", () => {
  it("lets an owner do what an assistant does, not the other way round", () => {
    expect(courseRoleAllows("owner", "owner")).toBe(true);
    expect(courseRoleAllows("owner", "assistant")).toBe(true);
    expect(courseRoleAllows("assistant", "assistant")).toBe(true);
    expect(courseRoleAllows("assistant", "owner")).toBe(false);
  });

  it("allows nothing without a role", () => {
    expect(courseRoleAllows(null, "assistant")).toBe(false);
  });
});

describe("staffChangeRefusal", () => {
  it("refuses to remove or demote the last owner", () => {
    expect(staffChangeRefusal({ owners: 1, targetRole: "owner", next: "remove" })).toBe("last_owner");
    expect(staffChangeRefusal({ owners: 1, targetRole: "owner", next: "assistant" })).toBe("last_owner");
  });

  it("lets an owner go while another one stays", () => {
    expect(staffChangeRefusal({ owners: 2, targetRole: "owner", next: "remove" })).toBeNull();
    expect(staffChangeRefusal({ owners: 2, targetRole: "owner", next: "assistant" })).toBeNull();
  });

  it("never refuses a change that keeps the owners as they are", () => {
    expect(staffChangeRefusal({ owners: 1, targetRole: "owner", next: "owner" })).toBeNull();
    expect(staffChangeRefusal({ owners: 1, targetRole: "assistant", next: "remove" })).toBeNull();
    expect(staffChangeRefusal({ owners: 1, targetRole: "assistant", next: "owner" })).toBeNull();
  });
});

describe("evaluationDeletionRole", () => {
  const blank = { mode: "exam", released: false, correctionPublished: false, studentAttempts: 0 } as const;

  it("leaves an evaluation no student took to every member", () => {
    for (const mode of ["exam", "exercise", "poll"] as const) {
      expect(evaluationDeletionRole({ ...blank, mode })).toBe("assistant");
    }
  });

  it("needs an owner once a student attempt, a release or a published correction exists", () => {
    expect(evaluationDeletionRole({ ...blank, studentAttempts: 1 })).toBe("owner");
    expect(evaluationDeletionRole({ ...blank, mode: "exercise", studentAttempts: 3 })).toBe("owner");
    expect(evaluationDeletionRole({ ...blank, released: true })).toBe("owner");
    expect(evaluationDeletionRole({ ...blank, mode: "exercise", correctionPublished: true })).toBe("owner");
  });

  it("does not count a poll's votes, only its release", () => {
    expect(evaluationDeletionRole({ ...blank, mode: "poll", studentAttempts: 40 })).toBe("assistant");
    expect(evaluationDeletionRole({ ...blank, mode: "poll", studentAttempts: 40, released: true })).toBe("owner");
  });
});

describe("evaluationGradingRole", () => {
  it("is every member's until the release, the owner's after it", () => {
    expect(evaluationGradingRole({ released: false })).toBe("assistant");
    expect(evaluationGradingRole({ released: true })).toBe("owner");
  });
});
