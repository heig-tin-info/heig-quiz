import { describe, expect, it } from "vitest";

import { changedAfterRelease, projectPrimaryAction, scoreGrade, scoresFinal, type PrimaryActionInput } from "./projectView.js";

describe("scoreGrade", () => {
  it("reads a score by the project's scale, with its own maximum", () => {
    expect(scoreGrade(5, 10, { kind: "linear" })).toEqual({ grade: 3.5, fellBack: false });
    expect(scoreGrade(4.5, 6, { kind: "score_is_grade" })).toEqual({ grade: 4.5, fellBack: false });
    expect(scoreGrade(8, 10, { kind: "score_is_grade" })).toEqual({ grade: 5, fellBack: true });
  });

  it("gives no grade without points or a maximum", () => {
    expect(scoreGrade(null, 10, { kind: "linear" })).toBeNull();
    expect(scoreGrade(4, null, { kind: "linear" })).toBeNull();
    expect(scoreGrade(4, 0, { kind: "linear" })).toBeNull();
  });
});

describe("changedAfterRelease", () => {
  const snap = { points: 8, max: 10 };
  it("is false before the release, whatever the score", () => {
    expect(changedAfterRelease(false, { points: 3, max: 10 }, { points: null, max: null })).toBe(false);
  });

  it("compares points and maximum with the snapshot", () => {
    expect(changedAfterRelease(true, { points: 8, max: 10 }, snap)).toBe(false);
    expect(changedAfterRelease(true, { points: 9, max: 10 }, snap)).toBe(true);
    expect(changedAfterRelease(true, { points: 8, max: 12 }, snap)).toBe(true);
  });

  it("sees a score that appeared or vanished since", () => {
    expect(changedAfterRelease(true, null, snap)).toBe(true);
    expect(changedAfterRelease(true, { points: 1, max: 6 }, { points: null, max: null })).toBe(true);
    expect(changedAfterRelease(true, null, { points: null, max: null })).toBe(false);
  });
});

describe("projectPrimaryAction (F-PROJ-13)", () => {
  const base: PrimaryActionInput = {
    state: "published",
    archived: false,
    gradingMode: "auto",
    sourceAhead: false,
    live: 3,
    frozen: 0,
    released: false,
    changedAfterRelease: 0,
  };

  it("publishes a draft, nothing for an archived project", () => {
    expect(projectPrimaryAction({ ...base, state: "draft" })).toBe("publish");
    expect(projectPrimaryAction({ ...base, state: "draft", archived: true })).toBe("none");
  });

  it("releases once every live repository is frozen, again only when a score changed", () => {
    expect(projectPrimaryAction({ ...base, state: "locked", frozen: 2 })).toBe("none");
    expect(projectPrimaryAction({ ...base, state: "locked", frozen: 3 })).toBe("release");
    expect(projectPrimaryAction({ ...base, state: "locked", frozen: 3, released: true })).toBe("none");
    expect(projectPrimaryAction({ ...base, state: "locked", frozen: 3, released: true, changedAfterRelease: 1 })).toBe("release");
  });

  it("never releases an ungraded project, nor one without a live repository", () => {
    expect(scoresFinal({ gradingMode: "none", live: 2, frozen: 2 })).toBe(false);
    expect(scoresFinal({ gradingMode: "auto", live: 0, frozen: 0 })).toBe(false);
  });

  it("syncs when the source is ahead and the scores are not final", () => {
    expect(projectPrimaryAction({ ...base, sourceAhead: true })).toBe("sync");
    expect(projectPrimaryAction({ ...base, sourceAhead: true, state: "locked", frozen: 3 })).toBe("release");
  });
});
