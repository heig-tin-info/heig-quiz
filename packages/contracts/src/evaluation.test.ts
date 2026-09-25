import { describe, expect, it } from "vitest";

import {
  DEFAULT_MCQ_POLICY,
  EvaluationPatch,
  EvaluationSettings,
  EvaluationSettingsPatch,
  RetakeSettings,
  retakesOf,
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

describe("retake settings (F-EVAL-15)", () => {
  it("reads a stored evaluation without the field as one attempt", () => {
    expect(EvaluationSettings.parse({}).retakes).toBeUndefined();
    expect(retakesOf(EvaluationSettings.parse({}))).toEqual({
      enabled: false,
      keep: "best",
      maxAttempts: null,
    });
  });

  it("fills the omitted fields of the object and bounds the maximum", () => {
    expect(RetakeSettings.parse({ enabled: true })).toEqual({
      enabled: true,
      keep: "best",
      maxAttempts: null,
    });
    expect(RetakeSettings.safeParse({ enabled: true, maxAttempts: 1 }).success).toBe(false);
    expect(RetakeSettings.safeParse({ enabled: true, keep: "worst" }).success).toBe(false);
  });

  it("travels whole in a settings patch, and is absent when not sent", () => {
    expect(EvaluationSettingsPatch.parse({ shuffleItems: true })).not.toHaveProperty("retakes");
    expect(
      EvaluationSettingsPatch.parse({ retakes: { enabled: true, keep: "last", maxAttempts: 3 } }).retakes,
    ).toEqual({ enabled: true, keep: "last", maxAttempts: 3 });
  });
});
