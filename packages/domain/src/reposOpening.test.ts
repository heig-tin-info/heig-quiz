import { describe, expect, it } from "vitest";

import {
  deadlineMoveRefusal,
  holdsStudentWork,
  nothingToOpen,
  repoOpenable,
  reposOpeningRefusal,
  type OpenableRepo,
  type ReposOpeningFacts,
} from "./reposOpening.js";
import { collaboratorPermission, type OpenedAccess } from "./workMode.js";

const DEADLINE = new Date("2026-11-20T12:00:00Z");
const before = new Date("2026-11-20T11:00:00Z");
const after = new Date("2026-11-20T13:00:00Z");

const REPO: OpenableRepo = {
  groupId: null,
  provisionStatus: "ok",
  fullName: "heig/lab-alice",
  deletedAt: null,
  frozenAt: new Date("2026-11-20T12:30:00Z"),
  work: true,
};

describe("holdsStudentWork (ADR-145 §7)", () => {
  it("counts the student's commits received by the deadline, a collection as one", () => {
    expect(holdsStudentWork([], DEADLINE)).toBe(false);
    expect(holdsStudentWork([{ receivedAt: before, commits: 2 }], DEADLINE)).toBe(true);
    // A collection's receipt carries no count: one commit (`studentCommitCount`'s rule).
    expect(holdsStudentWork([{ receivedAt: DEADLINE, commits: null }], DEADLINE)).toBe(true);
    // A push of no new commit, or one after the deadline, is no work.
    expect(holdsStudentWork([{ receivedAt: before, commits: 0 }], DEADLINE)).toBe(false);
    expect(holdsStudentWork([{ receivedAt: after, commits: 3 }], DEADLINE)).toBe(false);
  });
});

describe("repoOpenable and nothingToOpen (ADR-145 §7)", () => {
  it("opens an individual live repository frozen for good holding work", () => {
    expect(repoOpenable(REPO)).toBe(true);
    expect(nothingToOpen(REPO)).toBe(false);
  });

  it("opens nothing not frozen for good, deleted, not provisioned or a group's", () => {
    for (const repo of [
      { ...REPO, frozenAt: null },
      { ...REPO, deletedAt: new Date() },
      { ...REPO, provisionStatus: "error", fullName: null },
      { ...REPO, groupId: "g1" },
    ]) {
      expect(repoOpenable(repo)).toBe(false);
      expect(nothingToOpen(repo)).toBe(false);
    }
  });

  it("says nothing to open of a frozen repository without the student's work", () => {
    expect(repoOpenable({ ...REPO, work: false })).toBe(false);
    expect(nothingToOpen({ ...REPO, work: false })).toBe(true);
  });
});

describe("collaboratorPermission (ADR-047 §2 as amended by ADR-145)", () => {
  const open: OpenedAccess = { reposOpen: true, projectArchived: false, repo: REPO };

  it("pushes in the student's own tools and pulls online, whatever the opening", () => {
    for (const access of [undefined, open, { ...open, reposOpen: false }]) {
      expect(collaboratorPermission("free", access)).toBe("push");
      expect(collaboratorPermission("online", access)).toBe("pull");
    }
  });

  it("invites nobody under SEB until the repositories are opened, then pull on an openable one", () => {
    expect(collaboratorPermission("online_seb")).toBeNull();
    expect(collaboratorPermission("online_seb", { ...open, reposOpen: false })).toBeNull();
    expect(collaboratorPermission("online_seb", open)).toBe("pull");
    expect(collaboratorPermission("online_seb", { ...open, projectArchived: true })).toBeNull();
    // The absent student: their repository holds no work of theirs.
    expect(collaboratorPermission("online_seb", { ...open, repo: { ...REPO, work: false } })).toBeNull();
    expect(collaboratorPermission("online_seb", { ...open, repo: { ...REPO, frozenAt: null } })).toBeNull();
  });
});

describe("reposOpeningRefusal (ADR-145 §1)", () => {
  const graded: ReposOpeningFacts = {
    workMode: "online_seb",
    gradingMode: "auto",
    projectArchived: false,
    classroomArchived: false,
    opened: false,
    released: true,
    live: 3,
    frozen: 3,
    openable: 2,
  };

  it("lets the owner open a released graded project holding work", () => {
    expect(reposOpeningRefusal(graded)).toBeNull();
    expect(reposOpeningRefusal({ ...graded, gradingMode: "criteria" })).toBeNull();
  });

  it("refuses, in order, another mode, an archive, an opened project, no release, nothing to open", () => {
    expect(reposOpeningRefusal({ ...graded, workMode: "online", projectArchived: true })).toBe("not_supervised");
    expect(reposOpeningRefusal({ ...graded, workMode: "free" })).toBe("not_supervised");
    expect(reposOpeningRefusal({ ...graded, projectArchived: true, classroomArchived: true })).toBe("project_archived");
    expect(reposOpeningRefusal({ ...graded, classroomArchived: true })).toBe("classroom_archived");
    expect(reposOpeningRefusal({ ...graded, opened: true, released: false })).toBe("repos_already_open");
    expect(reposOpeningRefusal({ ...graded, released: false, openable: 0 })).toBe("not_released");
    expect(reposOpeningRefusal({ ...graded, openable: 0 })).toBe("nothing_to_open");
  });

  it("opens an ungraded project once every live repository is frozen for good", () => {
    const ungraded = { ...graded, gradingMode: "none" as const, released: false };
    expect(reposOpeningRefusal(ungraded)).toBeNull();
    expect(reposOpeningRefusal({ ...ungraded, frozen: 2 })).toBe("repos_not_frozen");
    expect(reposOpeningRefusal({ ...ungraded, live: 0, frozen: 0 })).toBe("repos_not_frozen");
  });
});

describe("deadlineMoveRefusal (ADR-145 §8)", () => {
  it("refuses a move that reopens a repository while the repositories are open", () => {
    expect(deadlineMoveRefusal({ opened: true, reopened: 1 })).toBe("repos_open");
    expect(deadlineMoveRefusal({ opened: true, reopened: 0 })).toBeNull();
    expect(deadlineMoveRefusal({ opened: false, reopened: 4 })).toBeNull();
  });
});
