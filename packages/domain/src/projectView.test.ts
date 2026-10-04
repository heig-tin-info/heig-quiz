import { describe, expect, it } from "vitest";

import {
  changedAfterRelease,
  projectPrimaryAction,
  reviewState,
  scoreGrade,
  scoresFinal,
  type PrimaryActionInput,
  type ReviewStateInput,
} from "./projectView.js";

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
    unverified: 0,
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

  it("never releases an ungraded project, one without a live repository, nor one with a score to verify", () => {
    expect(scoresFinal({ gradingMode: "none", live: 2, frozen: 2, unverified: 0 })).toBe(false);
    expect(scoresFinal({ gradingMode: "auto", live: 0, frozen: 0, unverified: 0 })).toBe(false);
    expect(scoresFinal({ gradingMode: "auto", live: 2, frozen: 2, unverified: 1 })).toBe(false);
    expect(projectPrimaryAction({ ...base, state: "locked", frozen: 3, unverified: 1 })).toBe("none");
  });

  it("syncs when the source is ahead and the scores are not final", () => {
    expect(projectPrimaryAction({ ...base, sourceAhead: true })).toBe("sync");
    expect(projectPrimaryAction({ ...base, sourceAhead: true, state: "locked", frozen: 3 })).toBe("release");
  });
});

describe("reviewState (F-PROJ-11, M3-08b)", () => {
  const at = new Date("2026-10-09T22:30:00Z");
  const frozen: ReviewStateInput = {
    gradingMode: "auto",
    frozenAt: at,
    frozenGradeRunId: "run-1",
    reviewGradeRunId: null,
    archivedAt: null,
    protectionSuspendedAt: null,
    dispatch: null,
  };
  const empty = { reason: null, askedAt: null, sha: null, runId: null };

  it("is pending before the freeze, and once frozen until the dispatch is claimed", () => {
    expect(reviewState({ ...frozen, frozenAt: null, frozenGradeRunId: null })).toEqual({ ...empty, status: "pending" });
    expect(reviewState(frozen)).toEqual({ ...empty, status: "pending" });
  });

  it("gives none to an ungraded project or a freeze without a run, and says why", () => {
    expect(reviewState({ ...frozen, gradingMode: "none" })).toEqual({ ...empty, status: "none" });
    expect(reviewState({ ...frozen, frozenGradeRunId: null })).toEqual({ ...empty, status: "none", reason: "no_frozen_run" });
  });

  it("skips a degraded repository, archived first", () => {
    expect(reviewState({ ...frozen, archivedAt: at, protectionSuspendedAt: at })).toEqual({ ...empty, status: "skipped", reason: "archived" });
    expect(reviewState({ ...frozen, protectionSuspendedAt: at })).toEqual({ ...empty, status: "skipped", reason: "protection_suspended" });
  });

  it("follows the ledger: unconfirmed, asked, then done with the run", () => {
    const claimed = { sha: "abc", dispatchedAt: null };
    expect(reviewState({ ...frozen, dispatch: claimed })).toEqual({ ...empty, status: "unconfirmed", sha: "abc" });
    const sent = { sha: "abc", dispatchedAt: at };
    expect(reviewState({ ...frozen, dispatch: sent })).toEqual({ ...empty, status: "asked", sha: "abc", askedAt: at });
    expect(reviewState({ ...frozen, dispatch: sent, reviewGradeRunId: "run-2" })).toEqual({
      status: "done",
      reason: null,
      sha: "abc",
      askedAt: at,
      runId: "run-2",
    });
    // The ledger wins over the row's state: a suspension after the dispatch changes nothing.
    expect(reviewState({ ...frozen, dispatch: sent, protectionSuspendedAt: at }).status).toBe("asked");
  });
});
