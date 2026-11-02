import { describe, expect, it } from "vitest";

import { FEEDBACK_WHEN } from "./evaluationConfig.js";
import { EVALUATION_STATES } from "./itemList.js";
import {
  correctionPublishRefusal,
  effectiveFeedbackPolicy,
  feedbackGate,
  feedbackGradeShown,
  isDebriefOpen,
} from "./correction.js";

describe("isDebriefOpen (ADR-033 §1, ADR-050)", () => {
  it("opens at the close, or earlier once the correction is published", () => {
    expect(EVALUATION_STATES.filter((state) => isDebriefOpen({ state, correctionPublished: false })))
      .toEqual(["closed", "grading", "released"]);
    expect(isDebriefOpen({ state: "running", correctionPublished: true })).toBe(true);
    expect(isDebriefOpen({ state: "lobby", correctionPublished: true })).toBe(true);
  });
});

describe("correctionPublishRefusal (ADR-050)", () => {
  it("refuses an exam and a poll whatever their state, the mode first", () => {
    expect(correctionPublishRefusal({ mode: "exam", state: "running" })).toBe("exam");
    expect(correctionPublishRefusal({ mode: "poll", state: "running" })).toBe("poll");
    expect(correctionPublishRefusal({ mode: "exam", state: "draft" })).toBe("exam");
  });

  it("accepts a running exercise, paused or not, and only then", () => {
    const accepted = EVALUATION_STATES.filter(
      (state) => correctionPublishRefusal({ mode: "exercise", state }) === null,
    );
    expect(accepted).toEqual(["running", "paused"]);
    expect(correctionPublishRefusal({ mode: "exercise", state: "lobby" })).toBe("not_open");
    expect(correctionPublishRefusal({ mode: "exercise", state: "closed" })).toBe("not_open");
  });
});

describe("effectiveFeedbackPolicy (ADR-124 §1)", () => {
  const stored = {
    when: "none",
    showAnswer: false,
    showKey: false,
    showExplanation: false,
    showHiddenCaseNames: false,
    showTeacherComment: false,
  } as const;

  it("shows an exercise's whole correction at the hand-in, whatever is stored", () => {
    for (const when of FEEDBACK_WHEN) {
      expect(effectiveFeedbackPolicy("exercise", { ...stored, when })).toEqual({
        when: "immediate",
        showAnswer: true,
        showKey: true,
        showExplanation: true,
        showHiddenCaseNames: false,
        showTeacherComment: false,
      });
    }
  });

  it("keeps the teacher's comment and the hidden case names as stored", () => {
    const kept = effectiveFeedbackPolicy("exercise", { ...stored, showHiddenCaseNames: true, showTeacherComment: true });
    expect(kept).toMatchObject({ showHiddenCaseNames: true, showTeacherComment: true });
  });

  it("leaves an exam's and a poll's policy as stored", () => {
    expect(effectiveFeedbackPolicy("exam", stored)).toBe(stored);
    expect(effectiveFeedbackPolicy("poll", stored)).toBe(stored);
  });
});

describe("feedbackGate (F-RES-04)", () => {
  const stored = {
    when: "on_release",
    showAnswer: true,
    showKey: false,
    showExplanation: false,
    showHiddenCaseNames: true,
    showTeacherComment: true,
  } as const;
  const base = { exam: false, evaluationOver: false, attemptOpen: false, released: false } as const;

  it("on_release: pending until the release", () => {
    expect(feedbackGate({ ...base, when: "on_release" })).toEqual({ ok: false, reason: "results_pending" });
    expect(feedbackGate({ ...base, when: "on_release", released: true })).toEqual({ ok: true });
  });

  it("immediate: at the hand-in", () => {
    expect(feedbackGate({ ...base, when: "immediate" })).toEqual({ ok: true });
  });

  it("none: nothing, even released", () => {
    expect(feedbackGate({ ...base, when: "none", released: true })).toEqual({ ok: false, reason: "no_feedback" });
  });

  it("an attempt still open reads nothing", () => {
    for (const when of ["on_release", "immediate"] as const) {
      expect(feedbackGate({ ...base, when, attemptOpen: true, released: true })).toEqual({
        ok: false,
        reason: "attempt_open",
      });
    }
  });

  it("an exercise, whatever its stored policy, reads its correction at the hand-in", () => {
    for (const when of FEEDBACK_WHEN) {
      const effective = effectiveFeedbackPolicy("exercise", { ...stored, when });
      expect(feedbackGate({ ...base, when: effective.when })).toEqual({ ok: true });
      expect(feedbackGate({ ...base, when: effective.when, attemptOpen: true })).toEqual({
        ok: false,
        reason: "attempt_open",
      });
    }
  });

  describe("an exam", () => {
    const exam = { ...base, exam: true } as const;

    it("shows nothing before its close, even under a legacy immediate policy", () => {
      for (const when of ["immediate", "on_release"] as const) {
        expect(feedbackGate({ ...exam, when })).toEqual({ ok: false, reason: "exam_open" });
      }
    });

    it("keeps the other reasons first: an open attempt, a policy that never shows", () => {
      expect(feedbackGate({ ...exam, when: "immediate", attemptOpen: true })).toEqual({
        ok: false,
        reason: "attempt_open",
      });
      expect(feedbackGate({ ...exam, when: "none" })).toEqual({ ok: false, reason: "no_feedback" });
    });

    it("follows its policy once over", () => {
      const over = { ...exam, evaluationOver: true } as const;
      expect(feedbackGate({ ...over, when: "immediate" })).toEqual({ ok: true });
      expect(feedbackGate({ ...over, when: "on_release" })).toEqual({ ok: false, reason: "results_pending" });
      expect(feedbackGate({ ...over, when: "on_release", released: true })).toEqual({ ok: true });
    });
  });
});


describe("feedbackGradeShown (F-RES-04)", () => {
  it("only once released, and never with a cell pending", () => {
    expect(feedbackGradeShown({ released: true, pendingCount: 0 })).toBe(true);
    expect(feedbackGradeShown({ released: true, pendingCount: 1 })).toBe(false);
    expect(feedbackGradeShown({ released: false, pendingCount: 0 })).toBe(false);
    expect(feedbackGradeShown({ released: false, pendingCount: 2 })).toBe(false);
  });
});
