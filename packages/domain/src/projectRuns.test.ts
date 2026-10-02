import { describe, expect, it } from "vitest";

import {
  deadlineWantsLock,
  effectiveDeadline,
  GRADING_WORKFLOW_PATH,
  receivedLate,
  reopens,
  runKind,
  selectScoreRun,
  type ScoredRun,
} from "./projectRuns.js";

const at = (h: number) => new Date(Date.UTC(2026, 9, 2, h));
let n = 0;
const run = (over: Partial<ScoredRun> = {}): ScoredRun => ({
  id: `r${n++}`,
  kind: "ci",
  afterDeadline: false,
  parseStatus: "ok",
  completedAt: at(10),
  headSha: "a",
  ...over,
});

describe("runKind", () => {
  it("is a review only for grading.yml dispatched by Quiz", () => {
    expect(runKind({ event: "repository_dispatch", path: GRADING_WORKFLOW_PATH })).toBe("review");
    expect(runKind({ event: "push", path: GRADING_WORKFLOW_PATH })).toBe("ci");
    // A student workflow listening to repository_dispatch cannot impersonate the review.
    expect(runKind({ event: "repository_dispatch", path: ".github/workflows/own.yml" })).toBe("ci");
    expect(runKind({ event: "", path: GRADING_WORKFLOW_PATH })).toBe("ci");
  });
});

describe("effectiveDeadline (D13 amended)", () => {
  it("is the repository's own deadline when it has one, the project's otherwise", () => {
    expect(effectiveDeadline({ deadlineAt: at(20) }, { deadlineAt: at(12) })).toEqual(at(20));
    expect(effectiveDeadline({ deadlineAt: null }, { deadlineAt: at(12) })).toEqual(at(12));
  });
});

describe("deadlineWantsLock (F-PROJ-09)", () => {
  it("follows the staff's hand, else the applied deadline with the lock strategy", () => {
    expect(deadlineWantsLock({ staffLock: null, deadlineAppliedAt: null }, "lock")).toBe(false);
    expect(deadlineWantsLock({ staffLock: null, deadlineAppliedAt: at(12) }, "lock")).toBe(true);
    expect(deadlineWantsLock({ staffLock: null, deadlineAppliedAt: at(12) }, "commit")).toBe(false);
    expect(deadlineWantsLock({ staffLock: false, deadlineAppliedAt: at(12) }, "lock")).toBe(false);
    expect(deadlineWantsLock({ staffLock: true, deadlineAppliedAt: null }, "commit")).toBe(true);
  });
});

describe("reopens (F-PROJ-09)", () => {
  it("reopens an applied deadline moved ahead of now, nothing else", () => {
    expect(reopens(at(10), at(14), at(12))).toBe(true);
    expect(reopens(at(10), at(11), at(12))).toBe(false);
    expect(reopens(null, at(14), at(12))).toBe(false);
  });
});

describe("receivedLate (ADR-012, GR-14.3)", () => {
  it("trusts the receipt over the current time", () => {
    expect(receivedLate(at(8), at(9), at(12))).toBe(false);
    expect(receivedLate(at(10), at(9), at(8))).toBe(true);
  });
  it("is late without a receipt once the deadline passed, on time ahead of it", () => {
    expect(receivedLate(null, at(9), at(10))).toBe(true);
    expect(receivedLate(null, at(9), at(8))).toBe(false);
  });
});

describe("selectScoreRun", () => {
  it("is null without a counted run", () => {
    expect(selectScoreRun([], new Set())).toBeNull();
  });

  it("picks the latest ok ci run by completion time, every decoy more recent and still losing", () => {
    const old = run({ completedAt: at(10) });
    const newer = run({ completedAt: at(11) });
    const decoys = [
      run({ kind: "review", completedAt: at(15) }),
      run({ afterDeadline: true, completedAt: at(16) }),
      run({ parseStatus: "malformed", completedAt: at(17) }),
      run({ parseStatus: "multiple", completedAt: at(18) }),
      run({ parseStatus: "no_annotation", completedAt: at(19) }),
      run({ parseStatus: "fallback", completedAt: at(20) }),
    ];
    expect(selectScoreRun([newer, ...decoys, old], new Set())).toBe(newer.id);
  });

  it("counts a fallback run only while the repository has no other run", () => {
    const build = run({ parseStatus: "fallback" });
    expect(selectScoreRun([build], new Set())).toBe(build.id);
    expect(selectScoreRun([build, run({ parseStatus: "no_annotation", afterDeadline: true })], new Set())).toBeNull();
  });

  it("never counts a run on a restored head", () => {
    const honest = run({ headSha: "s1", completedAt: at(10) });
    const tampered = run({ headSha: "s2", completedAt: at(11) });
    expect(selectScoreRun([honest, tampered], new Set(["s2"]))).toBe(honest.id);
  });
});
