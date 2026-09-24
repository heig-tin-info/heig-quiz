import { describe, expect, it } from "vitest";

import {
  DEFAULT_MCQ_POLICY,
  EvaluationPatch,
  EvaluationSettings,
  FeedbackPolicy,
  GradingScale,
  defaultFeedbackPolicy,
  defaultGradingScale,
  defaultSettings,
} from "./evaluation.js";

describe("defaultSettings", () => {
  it("is what a freshly created evaluation gets", () => {
    expect(defaultSettings()).toEqual({
      navigation: "free",
      presentation: "zen",
      lobby: "manual",
      shuffleItems: false,
      shuffleChoices: true,
      timing: "duration",
      showProgressBar: true,
      logVisibility: true,
      requireFullscreen: false,
    });
  });

  it("declares no poll block until an evaluation is one", () => {
    expect(defaultSettings().poll).toBeUndefined();
  });

  it("returns a fresh object every time, so two evaluations never share one", () => {
    expect(defaultSettings()).not.toBe(defaultSettings());
  });

  it("round-trips through its own schema", () => {
    expect(EvaluationSettings.parse(defaultSettings())).toEqual(defaultSettings());
  });
});

describe("defaultGradingScale", () => {
  it("is linear, rounded to the nearest", () => {
    expect(defaultGradingScale()).toEqual({ kind: "linear", rounding: "nearest" });
  });

  it("round-trips through its own schema", () => {
    expect(GradingScale.parse(defaultGradingScale())).toEqual(defaultGradingScale());
  });
});

describe("defaultFeedbackPolicy", () => {
  it("shows the answer on release and never the key", () => {
    expect(defaultFeedbackPolicy()).toEqual({
      when: "on_release",
      showAnswer: true,
      showKey: false,
      showExplanation: false,
      showHiddenCaseNames: true,
      showTeacherComment: true,
    });
  });

  it("round-trips through its own schema", () => {
    expect(FeedbackPolicy.parse(defaultFeedbackPolicy())).toEqual(defaultFeedbackPolicy());
  });
});

describe("DEFAULT_MCQ_POLICY", () => {
  it("is a member of the wire enum", () => {
    expect(() => EvaluationSettings.parse({})).not.toThrow();
    expect(DEFAULT_MCQ_POLICY).toBe("all_or_nothing");
  });
});

/*
 * #71: a patch carries what the caller sent and nothing else. Under zod 4 a
 * `.partial()` of a defaulted schema re-applies every default, and the
 * service's merge then reset the timing and the waiting room of a take-home
 * exercise the moment a teacher ticked "shuffle the questions".
 */
describe("EvaluationPatch", () => {
  it("keeps a settings patch to the fields it names", () => {
    expect(EvaluationPatch.parse({ settings: { shuffleItems: true } })).toEqual({
      settings: { shuffleItems: true },
    });
  });

  it("keeps a feedback patch to the fields it names", () => {
    expect(EvaluationPatch.parse({ feedbackPolicy: { showKey: true } })).toEqual({
      feedbackPolicy: { showKey: true },
    });
  });

  it("still validates each field it carries", () => {
    expect(EvaluationPatch.safeParse({ settings: { timing: "whenever" } }).success).toBe(false);
    expect(EvaluationPatch.safeParse({ feedbackPolicy: { when: "later" } }).success).toBe(false);
  });
});
