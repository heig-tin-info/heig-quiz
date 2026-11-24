import { describe, expect, it } from "vitest";

import { openingOf, reposOpeningRefusal, type OpenableRepo, type ReposOpeningFacts } from "./reposOpening.js";
import { collaboratorPermission } from "./workMode.js";

const REPO: OpenableRepo = {
  groupId: null,
  provisionStatus: "ok",
  fullName: "heig/lab-alice",
  deletedAt: null,
  frozenAt: new Date("2026-11-20T12:30:00Z"),
  work: true,
};

describe("openingOf (ADR-145 §7)", () => {
  it("opens an individual live repository frozen for good holding work, says nothing to open without work", () => {
    expect(openingOf(REPO)).toBe("open");
    expect(openingOf({ ...REPO, work: false })).toBe("nothing");
  });

  it("does not concern a repository not frozen for good, deleted, not provisioned or a group's", () => {
    for (const repo of [
      { ...REPO, frozenAt: null },
      { ...REPO, deletedAt: new Date() },
      { ...REPO, provisionStatus: "error", fullName: null },
      { ...REPO, groupId: "g1" },
    ]) {
      expect(openingOf(repo)).toBeNull();
      expect(openingOf({ ...repo, work: false })).toBeNull();
    }
  });
});

describe("collaboratorPermission (ADR-047 §2 as amended by ADR-145)", () => {
  it("pushes in the student's own tools and pulls online, whatever the opening", () => {
    for (const opened of [undefined, true, false]) {
      expect(collaboratorPermission("free", opened)).toBe("push");
      expect(collaboratorPermission("online", opened)).toBe("pull");
    }
  });

  it("invites nobody under SEB unless opened, then pull and never more", () => {
    expect(collaboratorPermission("online_seb")).toBeNull();
    expect(collaboratorPermission("online_seb", false)).toBeNull();
    expect(collaboratorPermission("online_seb", true)).toBe("pull");
  });
});

describe("reposOpeningRefusal (ADR-145 §1)", () => {
  const graded: ReposOpeningFacts = {
    workMode: "online_seb",
    gradingMode: "auto",
    projectArchived: false,
    classroomArchived: false,
    released: true,
    live: 3,
    frozen: 3,
    openable: 2,
  };

  it("lets the owner open a released graded project, every repository frozen, some holding work", () => {
    expect(reposOpeningRefusal(graded)).toBeNull();
    expect(reposOpeningRefusal({ ...graded, gradingMode: "criteria" })).toBeNull();
  });

  it("refuses, in order, another mode, an archive, no release, a repository not frozen, nothing to open", () => {
    expect(reposOpeningRefusal({ ...graded, workMode: "online", projectArchived: true })).toBe("not_supervised");
    expect(reposOpeningRefusal({ ...graded, workMode: "free" })).toBe("not_supervised");
    expect(reposOpeningRefusal({ ...graded, projectArchived: true, classroomArchived: true })).toBe("project_archived");
    expect(reposOpeningRefusal({ ...graded, classroomArchived: true })).toBe("classroom_archived");
    expect(reposOpeningRefusal({ ...graded, released: false, frozen: 2 })).toBe("not_released");
    // A make-up's repository given a later deadline after the release: the sitting still runs.
    expect(reposOpeningRefusal({ ...graded, frozen: 2, openable: 0 })).toBe("repos_not_frozen");
    expect(reposOpeningRefusal({ ...graded, openable: 0 })).toBe("nothing_to_open");
  });

  it("opens an ungraded project once every live repository is frozen for good", () => {
    const ungraded = { ...graded, gradingMode: "none" as const, released: false };
    expect(reposOpeningRefusal(ungraded)).toBeNull();
    expect(reposOpeningRefusal({ ...ungraded, frozen: 2 })).toBe("repos_not_frozen");
    expect(reposOpeningRefusal({ ...ungraded, live: 0, frozen: 0 })).toBe("repos_not_frozen");
  });
});
